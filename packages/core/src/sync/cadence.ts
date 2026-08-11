/**
 * Adaptive poll cadence (ADR 0008).
 *
 * A fixed interval is either too slow mid-conversation or too wasteful when
 * idle. These are pure functions over observed state so the policy can be
 * tested without a clock or a network.
 */

export const SYNC_STATES = ["hot", "warm", "cool", "idle", "paused"] as const;
export type SyncState = (typeof SYNC_STATES)[number];

export interface CadencePolicy {
  hotMs: number;
  warmMs: number;
  coolMs: number;
  idleMs: number;
  /** Activity newer than this means `hot`. */
  hotWindowMs: number;
  warmWindowMs: number;
  coolWindowMs: number;
  failureBaseMs: number;
  failureCapMs: number;
}

export const DEFAULT_CADENCE: CadencePolicy = {
  hotMs: 10_000,
  warmMs: 30_000,
  coolMs: 120_000,
  idleMs: 600_000,
  hotWindowMs: 5 * 60_000,
  warmWindowMs: 60 * 60_000,
  coolWindowMs: 24 * 60 * 60_000,
  failureBaseMs: 2_000,
  failureCapMs: 15 * 60_000,
};

export interface CadenceInput {
  now: number;
  /** Timestamp of the most recent message in any subscribed room. */
  lastActivityAt: number | null;
  /**
   * An unanswered `needs: human` is pending. Holds the poll at `warm` at worst,
   * because someone is actively blocked waiting for the answer to arrive.
   */
  hasPendingHumanDecision: boolean;
  /** A local agent session is live — the human is here now, so freshness matters. */
  sessionLive: boolean;
  online: boolean;
  /** Machine asleep, on battery saver, or explicitly paused. */
  suspended: boolean;
}

export function nextState(input: CadenceInput, policy: CadencePolicy = DEFAULT_CADENCE): SyncState {
  if (!input.online || input.suspended) return "paused";

  // A live session is the moment freshness has value: because agents are guests
  // (ADR 0006), this is when someone is actually about to read the inbox.
  if (input.sessionLive) return "hot";

  const age =
    input.lastActivityAt === null ? Number.POSITIVE_INFINITY : input.now - input.lastActivityAt;

  if (age <= policy.hotWindowMs) return "hot";
  if (input.hasPendingHumanDecision) return "warm";
  if (age <= policy.warmWindowMs) return "warm";
  if (age <= policy.coolWindowMs) return "cool";
  return "idle";
}

/** Poll interval for a state; null means "do not poll". */
export function intervalFor(
  state: SyncState,
  policy: CadencePolicy = DEFAULT_CADENCE,
): number | null {
  switch (state) {
    case "hot":
      return policy.hotMs;
    case "warm":
      return policy.warmMs;
    case "cool":
      return policy.coolMs;
    case "idle":
      return policy.idleMs;
    case "paused":
      return null;
  }
}

/**
 * Backoff after consecutive sync failures, with full jitter.
 *
 * Without jitter every machine on a team retries in lockstep after a shared
 * outage and hammers the host the moment it recovers.
 */
export function failureBackoff(
  consecutiveFailures: number,
  policy: CadencePolicy = DEFAULT_CADENCE,
  rand: () => number = Math.random,
): number {
  if (consecutiveFailures <= 0) return 0;
  const ceiling = Math.min(
    policy.failureCapMs,
    policy.failureBaseMs * 2 ** (consecutiveFailures - 1),
  );
  return Math.floor(rand() * ceiling);
}

/**
 * Tracks cadence across polls. Deliberately holds no timer of its own — the
 * daemon owns scheduling; this only answers "how long until the next poll".
 */
export class CadenceController {
  private consecutiveFailures = 0;
  private readonly policy: CadencePolicy;

  constructor(policy: CadencePolicy = DEFAULT_CADENCE) {
    this.policy = policy;
  }

  get failures(): number {
    return this.consecutiveFailures;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
  }

  /** Next delay in ms, or null when polling is paused. */
  nextDelay(input: CadenceInput, rand: () => number = Math.random): number | null {
    const state = nextState(input, this.policy);
    if (state === "paused") return null;
    const base = intervalFor(state, this.policy) as number;
    if (this.consecutiveFailures === 0) return base;
    // While failing, back off past the nominal cadence rather than under it.
    return Math.max(base, failureBackoff(this.consecutiveFailures, this.policy, rand));
  }
}
