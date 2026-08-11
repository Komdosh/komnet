import {
  CadenceController,
  DEFAULT_CADENCE,
  nextState,
  type CadenceInput,
  type CadencePolicy,
  type Network,
  type SyncReport,
  type SyncState,
} from "@kom-net/core";

export interface SyncLoopOptions {
  network: Network;
  /** Whether an agent session is currently attached (drives the HOT state). */
  sessionLive: () => boolean;
  onReport: (report: SyncReport) => void | Promise<void>;
  onError: (error: unknown) => void;
  /** Override the poll cadence. Mainly for tests and for tuning a busy network. */
  cadence?: CadencePolicy;
  log?: (message: string) => void;
}

/**
 * Drives `Network.sync` on the adaptive cadence (ADR 0008).
 *
 * Scheduled with a chained timer rather than an interval: a sync can outlast
 * its own interval on a slow network, and `setInterval` would stack overlapping
 * runs that then contend for the same lock.
 */
export class SyncLoop {
  private readonly options: SyncLoopOptions;
  private readonly policy: CadencePolicy;
  private readonly cadence: CadenceController;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private syncing = false;
  private lastState: SyncState = "idle";
  private lastRunAt: number | null = null;
  private startedAt = Date.now();

  constructor(options: SyncLoopOptions) {
    this.options = options;
    this.policy = options.cadence ?? DEFAULT_CADENCE;
    this.cadence = new CadenceController(this.policy);
  }

  get state(): SyncState {
    return this.lastState;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get lastSyncAt(): number | null {
    return this.lastRunAt;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Force an immediate poll — a local send, or a session opening. */
  wake(reason: string): void {
    if (!this.running) return;
    this.options.log?.(`wake: ${reason}`);
    this.schedule(0);
  }

  private input(): CadenceInput {
    const state = this.options.network.state;
    const observed = state.lastActivityAt();

    // Starting the daemon counts as activity.
    //
    // Without this, a fresh install has an empty inbox, so "last activity" is
    // never, and the loop drops straight to the 10-minute IDLE cadence — least
    // responsive at exactly the moment someone is first trying it out. Treating
    // startup as a reason to expect traffic makes a new daemon feel alive, and
    // it still settles to IDLE a day later if nothing happens.
    const lastActivityAt = observed === null ? this.startedAt : Math.max(observed, this.startedAt);

    return {
      now: Date.now(),
      lastActivityAt,
      hasPendingHumanDecision: state.hasPendingHumanDecision(),
      sessionLive: this.options.sessionLive(),
      online: true,
      suspended: false,
    };
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    // Never hold the process open on our own account; the IPC server decides
    // the daemon's lifetime.
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    // A wake during a long sync must not start a second one against the same
    // worktree; the next schedule picks it up.
    if (this.syncing) {
      this.schedule(1_000);
      return;
    }

    this.syncing = true;
    try {
      const report = await this.options.network.sync();
      this.cadence.recordSuccess();
      this.lastRunAt = Date.now();
      await this.options.onReport(report);
    } catch (error) {
      this.cadence.recordFailure();
      this.options.onError(error);
    } finally {
      this.syncing = false;
    }

    // Re-check AFTER the await. `stop()` can land while a sync is in flight,
    // and the daemon closes each network's StateDb right after stopping its
    // loop — so reaching `input()` here would read a closed database and throw
    // from inside a `void this.tick()`, i.e. an unhandled rejection that takes
    // the process down rather than surfacing anywhere useful.
    if (!this.running) return;

    const input = this.input();
    this.lastState = nextState(input);
    const delay = this.cadence.nextDelay(input);
    // `paused` means no polling; re-check in a minute rather than stopping
    // outright, so the loop resumes on its own when conditions change.
    this.schedule(delay ?? 60_000);
  }
}
