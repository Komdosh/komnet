import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import {
  Layout,
  Network,
  ReviewRepositoryResolver,
  loadConfig,
  describeError,
  type ApprovalKind,
  type AgendaEntry,
  type AgentRuntimeEnvironment,
  type CadencePolicy,
  type KomnetConfig,
  type NetworkConfig,
  type SyncReport,
} from "@komnet/core";
import type { Message } from "@komnet/protocol";

import { SyncLoop } from "./loop.ts";
import { createNotifier, shouldNotify, type Notifier, type NotifierKind } from "./notify.ts";
import {
  LineFramer,
  encode,
  isMethod,
  type IpcRequest,
  type IpcResponse,
  type Method,
} from "./protocol.ts";
import { DaemonClient } from "./client.ts";

export interface DaemonOptions {
  layout?: Layout;
  notifier?: NotifierKind;
  /** Suppress the sync loop; used by tests that drive `sync` explicitly. */
  autoSync?: boolean;
  /** Override the poll cadence — for tests, and for tuning a busy network. */
  cadence?: CadencePolicy;
  /**
   * How often to scan for work that has stopped moving. Defaults to
   * `STALL_SCAN_INTERVAL_MS`; tests set it to 0 so "reported once" is proven by
   * the reported-set rather than by the rate limiter.
   */
  stallScanIntervalMs?: number;
  /** Debounce brief editor/MCP reconnects so presence does not chatter on main. */
  presenceAwayGraceMs?: number;
  log?: (message: string) => void;
}

interface NetworkContext {
  config: NetworkConfig;
  network: Network;
  loop: SyncLoop;
}

/**
 * The one long-lived local process (ADR 0005).
 *
 * Owns continuous sync, the inbox, notifications and presence, and serves the
 * unix socket that the CLI and MCP server talk to. Its real job is the thing a
 * per-invocation CLI structurally cannot do: **accumulate an inbox while no
 * agent is running**, which is what makes the staged-delivery model work
 * (ADR 0006).
 */
export class Daemon {
  readonly layout: Layout;
  private readonly options: DaemonOptions;
  private readonly notifier: Notifier;
  private readonly networks = new Map<string, NetworkContext>();
  private readonly sessions = new Set<Socket>();
  private server: Server | null = null;
  private config: KomnetConfig | null = null;
  private stopping = false;
  private sealing = false;
  private nextConnectionId = 1;
  private presenceAwayTimer: NodeJS.Timeout | null = null;
  /** Per-network clock for the stalled-work scan. See `escalateStalledWork`. */
  private readonly lastStallScanAt = new Map<string, number>();
  /** Activation timestamps per network, for the per-hour ceiling. */
  private readonly activations = new Map<string, number[]>();

  constructor(options: DaemonOptions = {}) {
    this.options = options;
    this.layout = options.layout ?? new Layout();
    this.notifier = createNotifier(
      options.notifier ?? "os",
      join(this.layout.inboxDir, "NOTICE.md"),
    );
  }

  private log(message: string): void {
    const line = `${new Date().toISOString()} ${message}`;
    this.options.log?.(line);
    void appendFile(join(this.layout.logsDir, "daemon.log"), `${line}\n`, "utf8").catch(
      () => undefined,
    );
  }

  /** True while any agent session is attached — drives HOT cadence and presence. */
  get sessionLive(): boolean {
    return this.sessions.size > 0;
  }

  get socketPath(): string {
    return this.layout.socketPath;
  }

  async start(): Promise<void> {
    await mkdir(this.layout.logsDir, { recursive: true });
    await this.reload();
    // Repair a live card left behind by a daemon/editor crash. This is a no-op
    // in the normal away state because agent-card writes are transition-only.
    await this.publishPresence("away");
    await this.listen();
    if (this.options.autoSync !== false) {
      for (const ctx of this.networks.values()) ctx.loop.start();
    }
    this.log(`daemon ready on ${this.socketPath} (${String(this.networks.size)} network(s))`);
  }

  /** Load config and open every configured network. */
  private async reload(): Promise<void> {
    const config = await loadConfig(this.layout.configPath);
    if (config === null)
      throw new Error(`no config at ${this.layout.configPath} — run: komnet init`);
    this.config = config;

    for (const netConfig of Object.values(config.networks)) {
      if (this.networks.has(netConfig.id)) continue;
      const network = Network.open(this.layout, netConfig, config.agent);
      const loop = new SyncLoop({
        network,
        sessionLive: () => this.sessionLive,
        onReport: async (report) => {
          await this.onReport(netConfig.id, network, report);
          void this.maybeSeal(netConfig.id, network);
        },
        onError: (error) => this.log(`sync failed [${netConfig.id}]: ${describeError(error)}`),
        ...(this.options.cadence === undefined ? {} : { cadence: this.options.cadence }),
        log: (message) => this.log(`[${netConfig.id}] ${message}`),
      });
      this.networks.set(netConfig.id, { config: netConfig, network, loop });
    }
  }

  /**
   * React to a completed sync: stage what arrived, then look at what did not.
   *
   * Both halves belong here rather than at the call site, because a sync
   * reaches this from two directions — the poll loop and an explicit `sync`
   * over IPC — and a signal that fires on only one of them is worse than none.
   */
  private async onReport(networkId: string, network: Network, report: SyncReport): Promise<void> {
    await this.stageDelivered(networkId, network, report);
    await this.escalateStalledWork(networkId, network).catch((error: unknown) =>
      this.log(`stalled-work scan failed: ${describeError(error)}`),
    );
  }

  /** Stage the inbox on disk and decide what deserves a human's attention. */
  private async stageDelivered(
    networkId: string,
    network: Network,
    report: SyncReport,
  ): Promise<void> {
    if (report.delivered > 0) {
      this.log(`[${networkId}] delivered ${String(report.delivered)} message(s)`);
      await network.writeInboxFiles().catch((error: unknown) => {
        this.log(`inbox render failed: ${describeError(error)}`);
      });
    }
    for (const anomaly of report.anomalies) {
      // A modified or deleted message violates the append-only invariant, so it
      // is surfaced rather than quietly tolerated (ADR 0004).
      this.log(`[${networkId}] PROTOCOL ANOMALY ${anomaly.status} ${anomaly.path}`);
    }

    const notable = report.deliveredMessages.filter((message) =>
      shouldNotify({
        needs: message.header.needs,
        priority: message.header.priority,
        directlyMentioned: message.header.mentions.includes(network.identity.id),
        sessionLive: this.sessionLive,
      }),
    );
    if (notable.length === 0) return;

    const urgent = notable.some(
      (m) => m.header.needs === "human" || m.header.priority === "blocking",
    );
    await this.notifier
      .notify({
        title: summariseTitle(notable),
        body: summariseBody(notable),
        urgent,
      })
      .catch((error: unknown) => this.log(`notify failed: ${describeError(error)}`));

    await this.maybeActivate(networkId, network, notable.length);
  }

  /**
   * Start an agent, if and only if this machine's owner asked for it.
   *
   * komnet's default is still that it never spawns a session (ADR 0006): agents
   * bill against interactive plans, and spending someone's money uninvited is
   * indefensible. But the person who owns the machine and the plan may decide
   * otherwise, and only they can — `activation` lives in the machine-local
   * policy file, so no peer can switch it on from the network.
   *
   * Three guards, because the failure mode here is financial: nothing runs
   * while a session is already attached (it will drain on its own), nothing
   * runs more than `maxPerHour`, and the command is argv with no shell so a
   * message body can never become part of it.
   */
  private async maybeActivate(networkId: string, network: Network, arrived: number): Promise<void> {
    if (arrived === 0 || this.sessionLive) return;
    const { policy } = await network.policy();
    const activation = policy.activation;
    if (activation.mode !== "command" || activation.command.length === 0) return;

    const now = Date.now();
    const recent = (this.activations.get(networkId) ?? []).filter((at) => now - at < 60 * 60_000);
    if (recent.length >= activation.maxPerHour) {
      this.log(
        `[${networkId}] activation suppressed: ${String(activation.maxPerHour)}/hour reached`,
      );
      this.activations.set(networkId, recent);
      return;
    }
    recent.push(now);
    this.activations.set(networkId, recent);

    const [command, ...args] = activation.command as [string, ...string[]];
    this.log(
      `[${networkId}] activating: ${command} (${String(recent.length)}/${String(activation.maxPerHour)} this hour)`,
    );
    try {
      const { spawn } = await import("node:child_process");
      const child = spawn(command, args, { shell: false, stdio: "ignore", detached: true });
      child.on("error", (error) => this.log(`activation failed: ${describeError(error)}`));
      child.unref();
    } catch (error) {
      this.log(`activation failed: ${describeError(error)}`);
    }
  }

  /**
   * Surface long-running work that has stopped moving.
   *
   * Every other signal in komnet is triggered by a message arriving. Silence is
   * the one that is not: a task whose owner simply stopped produces no event,
   * so a deadline could pass with nobody told — which made `stale_after`
   * decorative. This is the timer that makes it mean something.
   *
   * Local only. The daemon never writes to the shared log on the agent's
   * behalf: each peer runs one of these, so a task nagging from every machine
   * would put N copies of the same complaint in a permanent team-wide record.
   */
  private async escalateStalledWork(networkId: string, network: Network): Promise<void> {
    const last = this.lastStallScanAt.get(networkId) ?? 0;
    // A deadline is a wall-clock event, so this cannot ride on traffic; it is
    // rate-limited instead, because re-reading every subscribed room is not
    // free and the shortest useful threshold is still minutes.
    const interval = this.options.stallScanIntervalMs ?? STALL_SCAN_INTERVAL_MS;
    if (Date.now() - last < interval) return;
    this.lastStallScanAt.set(networkId, Date.now());

    const agenda = await network.agenda({ includeUnclaimed: false });
    const stalled = agenda.entries.filter((entry) => entry.needsAttention);
    // Keyed by health, not by id alone, so blocked → stuck is a new fact and a
    // task that recovers and stalls again is reported again.
    const current = stalled.map((entry) => `${entry.status.task.id}:${entry.status.health}`);
    const announced = new Set(decodeAnnounced(network.state.getMeta(STALLED_META_KEY)));
    network.state.setMeta(STALLED_META_KEY, JSON.stringify(current));

    const fresh = stalled.filter(
      (entry) => !announced.has(`${entry.status.task.id}:${entry.status.health}`),
    );
    if (fresh.length === 0) return;

    this.log(`[${networkId}] ${String(fresh.length)} task(s) need attention`);
    await this.notifier
      .notify({
        title:
          fresh.length === 1
            ? `task ${(fresh[0] as AgendaEntry).status.health}`
            : `${String(fresh.length)} tasks need attention`,
        body: fresh.map(describeStalledTask).join("; "),
      })
      .catch((error: unknown) => this.log(`notify failed: ${describeError(error)}`));
  }

  /**
   * Compact any room that has outgrown its retention window.
   *
   * Deliberately NOT awaited by the sync loop: a seal pushes several times and
   * can take a while, and blocking the loop on it would stall delivery. The
   * `sealing` guard keeps concurrent seals from piling up, and the git-CAS lock
   * (spec §11) keeps other machines out.
   */
  private async maybeSeal(networkId: string, network: Network): Promise<void> {
    if (this.sealing) return;
    this.sealing = true;
    try {
      const due = await network.roomsNeedingSeal();
      for (const decision of due) {
        this.log(`[${networkId}] sealing ${decision.roomId}: ${decision.reason}`);
        const result = await network.seal(decision.roomId);
        this.log(
          result.sealed > 0
            ? `[${networkId}] sealed ${String(result.sealed)} from ${decision.roomId} → ${String(result.digest)}`
            : `[${networkId}] seal of ${decision.roomId} skipped: ${String(result.skipped)}`,
        );
      }
    } catch (error) {
      // Retention falling behind degrades performance, never correctness — the
      // messages are still there. Never let it take the daemon down.
      this.log(`[${networkId}] seal failed: ${describeError(error)}`);
    } finally {
      this.sealing = false;
    }
  }

  // ---------------------------------------------------------------- ipc

  private async listen(): Promise<void> {
    const path = this.socketPath;
    await mkdir(this.layout.root, { recursive: true });

    // A socket file left by a crash would make bind fail. Probe it first:
    // if something answers, another daemon owns this home and we must not
    // start a second one; if nothing does, the file is debris.
    const alive = await DaemonClient.isAlive(path);
    if (alive) {
      throw new Error(`another komnet daemon is already running on ${path}`);
    }
    await unlink(path).catch(() => undefined);

    const server = createServer((socket) => {
      this.onConnection(socket);
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });

    // Filesystem permissions ARE the authentication here — there is no token
    // and nothing listening on TCP (ADR 0005).
    await chmod(path, 0o600);
  }

  private onConnection(socket: Socket): void {
    const connectionId = this.nextConnectionId++;
    const framer = new LineFramer();
    let declaredSession = false;

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      let lines: string[];
      try {
        lines = framer.push(chunk);
      } catch (error) {
        socket.end(encode({ id: 0, ok: false, error: { message: describeError(error) } }));
        return;
      }
      for (const line of lines) {
        void this.handleLine(socket, line, {
          isSession: () => declaredSession,
          markSession: (on: boolean) => {
            declaredSession = on;
            if (on) this.sessions.add(socket);
            else this.sessions.delete(socket);
          },
        });
      }
    });

    const cleanup = () => {
      if (declaredSession) {
        this.sessions.delete(socket);
        void this.onSessionChange();
      }
      this.log(`connection ${String(connectionId)} closed`);
    };
    socket.on("close", cleanup);
    socket.on("error", () => cleanup());
  }

  private async handleLine(
    socket: Socket,
    line: string,
    session: { isSession: () => boolean; markSession: (on: boolean) => void },
  ): Promise<void> {
    let request: IpcRequest;
    try {
      request = JSON.parse(line) as IpcRequest;
    } catch {
      socket.write(encode({ id: 0, ok: false, error: { message: "malformed JSON" } }));
      return;
    }

    const respond = (response: IpcResponse) => {
      if (!socket.destroyed) socket.write(encode(response));
    };

    if (typeof request.method !== "string" || !isMethod(request.method)) {
      respond({
        id: request.id ?? 0,
        ok: false,
        error: { message: `unknown method ${String(request.method)}`, code: "UNKNOWN_METHOD" },
      });
      return;
    }

    try {
      const result = await this.dispatch(request.method, request, session);
      respond({ id: request.id, ok: true, result });
    } catch (error) {
      const code = errorCode(error);
      respond({
        id: request.id,
        ok: false,
        error: { message: describeError(error), ...(code === undefined ? {} : { code }) },
      });
    }
  }

  private resolve(networkId?: string): NetworkContext {
    if (this.networks.size === 0) throw new Error("no networks configured — run: komnet init");
    if (networkId !== undefined) {
      const ctx = this.networks.get(networkId);
      if (ctx === undefined) throw new Error(`unknown network ${networkId}`);
      return ctx;
    }
    const preferred = this.config?.defaultNetwork;
    if (preferred !== undefined && preferred !== null) {
      const ctx = this.networks.get(preferred);
      if (ctx !== undefined) return ctx;
    }
    if (this.networks.size > 1) {
      throw new Error(
        `several networks configured; specify one of: ${[...this.networks.keys()].join(", ")}`,
      );
    }
    return [...this.networks.values()][0] as NetworkContext;
  }

  private async dispatch(
    method: Method,
    request: IpcRequest,
    session: { isSession: () => boolean; markSession: (on: boolean) => void },
  ): Promise<unknown> {
    const params = request.params ?? {};
    const p = <T>(key: string): T | undefined => params[key] as T | undefined;

    switch (method) {
      case "ping":
        return { pong: true, pid: process.pid, networks: [...this.networks.keys()] };

      case "sessionOpen": {
        // An MCP server's lifetime IS an agent session's lifetime, which is
        // what makes presence meaningful rather than guessed.
        session.markSession(true);
        await this.onSessionChange();
        const environment = p<AgentRuntimeEnvironment>("environment");
        if (environment !== undefined) await this.publishProfiles(environment);
        return { sessionLive: true, sessions: this.sessions.size };
      }
      case "sessionClose": {
        session.markSession(false);
        await this.onSessionChange();
        return { sessionLive: this.sessionLive, sessions: this.sessions.size };
      }

      case "shutdown":
        setTimeout(() => void this.stop(), 10).unref();
        return { stopping: true };

      case "status": {
        const ctx = this.resolve(request.network);
        const status = await ctx.network.status();
        return {
          ...status,
          daemon: {
            pid: process.pid,
            socket: this.socketPath,
            sessionLive: this.sessionLive,
            sessions: this.sessions.size,
            cadence: ctx.loop.state,
            loopRunning: ctx.loop.isRunning,
            lastLoopSyncAt: ctx.loop.lastSyncAt,
          },
        };
      }

      case "sync": {
        const ctx = this.resolve(request.network);
        const report = await ctx.network.sync();
        await this.onReport(ctx.config.id, ctx.network, report);
        return report;
      }

      case "rooms":
        return await this.resolve(request.network).network.listRooms();

      case "roomShow":
        return await this.resolve(request.network).network.readRoomConfig(p<string>("room") ?? "");

      case "roomCreate": {
        const ctx = this.resolve(request.network);
        const title = p<string>("title");
        const purpose = p<string>("purpose");
        const replyBudget = p<number>("replyBudget");
        const room = await ctx.network.createRoom(p<string>("room") ?? "", {
          ...(title === undefined ? {} : { title }),
          ...(purpose === undefined ? {} : { purpose }),
          ...(replyBudget === undefined ? {} : { replyBudget }),
        });
        await this.persistSubscriptions();
        ctx.loop.wake("room created");
        return room;
      }

      case "roomJoin": {
        const ctx = this.resolve(request.network);
        await ctx.network.joinRoom(p<string>("room") ?? "");
        await this.persistSubscriptions();
        ctx.loop.wake("room joined");
        return { joined: p<string>("room") };
      }

      case "roomLeave": {
        const ctx = this.resolve(request.network);
        await ctx.network.leaveRoom(p<string>("room") ?? "");
        await this.persistSubscriptions();
        return { left: p<string>("room") };
      }

      case "send": {
        const ctx = this.resolve(request.network);
        const message = await ctx.network.send(
          p<string>("room") ?? "",
          (params["input"] ?? {}) as Parameters<Network["send"]>[1],
        );
        // A reply is likely imminent, so drop straight to the hot cadence.
        ctx.loop.wake("local send");
        return message;
      }

      case "answer": {
        const ctx = this.resolve(request.network);
        // No `confirmHuman`: the socket is the ordinary agent path. Human-relay
        // attribution stays on the interactive CLI and is cooperative, not proof.
        const message = await ctx.network.answer(
          p<string>("messageId") ?? "",
          p<string>("body") ?? "",
        );
        ctx.loop.wake("local answer");
        return message;
      }

      case "reviewRequest": {
        const ctx = this.resolve(request.network);
        const message = await ctx.network.requestReview(
          p<string>("room") ?? "",
          (params["input"] ?? {}) as Parameters<Network["requestReview"]>[1],
        );
        ctx.loop.wake("review requested");
        return message;
      }

      case "reviewUpdate": {
        const ctx = this.resolve(request.network);
        const message = await ctx.network.updateReview(
          p<string>("room") ?? "",
          p<string>("reviewId") ?? "",
          (params["input"] ?? {}) as Parameters<Network["updateReview"]>[2],
        );
        ctx.loop.wake("review updated");
        return message;
      }

      case "reviewPrepare": {
        const ctx = this.resolve(request.network);
        const reviewId = p<string>("reviewId") ?? "";
        const status = (await ctx.network.listReviewTasks(p<string>("room") ?? "")).find(
          (candidate) => candidate.review.id === reviewId,
        );
        if (status === undefined) throw new Error(`no review task ${reviewId}`);
        const config = await loadConfig(this.layout.configPath);
        if (config === null) throw new Error(`no config at ${this.layout.configPath}`);
        return await new ReviewRepositoryResolver(this.layout, config).prepare(
          status.review,
          ctx.network.identity.id,
        );
      }

      case "reviewRelease": {
        const ctx = this.resolve(request.network);
        const config = await loadConfig(this.layout.configPath);
        if (config === null) throw new Error(`no config at ${this.layout.configPath}`);
        return await new ReviewRepositoryResolver(this.layout, config).release(
          p<string>("reviewId") ?? "",
          ctx.network.identity.id,
        );
      }

      case "reviews":
        return await this.resolve(request.network).network.listReviewTasks(p<string>("room") ?? "");

      case "taskCreate": {
        const ctx = this.resolve(request.network);
        const message = await ctx.network.createTask(
          p<string>("room") ?? "",
          (params["input"] ?? {}) as Parameters<Network["createTask"]>[1],
        );
        ctx.loop.wake("task created");
        return message;
      }

      case "taskClaim": {
        const ctx = this.resolve(request.network);
        const message = await ctx.network.claimTask(
          p<string>("room") ?? "",
          p<string>("taskId") ?? "",
          p<string>("body") ?? "",
        );
        ctx.loop.wake("task claimed");
        return message;
      }

      case "taskUpdate": {
        const ctx = this.resolve(request.network);
        const message = await ctx.network.updateTask(
          p<string>("room") ?? "",
          p<string>("taskId") ?? "",
          (params["input"] ?? {}) as Parameters<Network["updateTask"]>[2],
        );
        ctx.loop.wake("task updated");
        return message;
      }

      case "tasks":
        return await this.resolve(request.network).network.listTasks(p<string>("room") ?? "");

      case "claim": {
        const ctx = this.resolve(request.network);
        const ttlSeconds = p<number>("ttlSeconds");
        const note = p<string>("note");
        const result = await ctx.network.claimResource(
          p<string>("room") ?? "",
          p<string>("resource") ?? "",
          {
            ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
            ...(note === undefined ? {} : { note }),
          },
        );
        ctx.loop.wake("resource claimed");
        return result;
      }

      case "claimRelease": {
        const ctx = this.resolve(request.network);
        const released = await ctx.network.releaseResource(
          p<string>("room") ?? "",
          p<string>("resource") ?? "",
        );
        ctx.loop.wake("resource released");
        return { released };
      }

      case "claims":
        return await this.resolve(request.network).network.listClaims(p<string>("room") ?? "");

      case "taskShow":
        return await this.resolve(request.network).network.showTask(
          p<string>("room") ?? "",
          p<string>("taskId") ?? "",
        );

      case "policy":
        return await this.resolve(request.network).network.policy();

      case "approvals":
        return await this.resolve(request.network).network.listApprovals();

      case "approve": {
        const ctx = this.resolve(request.network);
        const note = p<string>("note");
        const record = await ctx.network.approveInboundWork(
          (p<string>("kind") ?? "task") as ApprovalKind,
          p<string>("room") ?? "",
          p<string>("id") ?? "",
          ...(note === undefined ? [] : [note]),
        );
        this.log(`[${ctx.config.id}] approved ${record.kind} ${record.id}`);
        return record;
      }

      case "approveRevoke": {
        const ctx = this.resolve(request.network);
        return {
          revoked: await ctx.network.revokeApproval(
            (p<string>("kind") ?? "task") as ApprovalKind,
            p<string>("id") ?? "",
          ),
        };
      }

      case "agenda": {
        const ctx = this.resolve(request.network);
        const limit = p<number>("limit");
        const includeUnclaimed = p<boolean>("includeUnclaimed");
        return await ctx.network.agenda({
          ...(limit === undefined ? {} : { limit }),
          ...(includeUnclaimed === undefined ? {} : { includeUnclaimed }),
        });
      }

      case "read": {
        const ctx = this.resolve(request.network);
        const limit = p<number>("limit");
        const thread = p<string>("thread");
        return await ctx.network.read(p<string>("room") ?? "", {
          ...(limit === undefined ? {} : { limit }),
          ...(thread === undefined ? {} : { thread }),
        });
      }

      case "history": {
        const ctx = this.resolve(request.network);
        const since = p<string>("since");
        const limit = p<number>("limit");
        return await ctx.network.history(p<string>("room") ?? "", {
          ...(since === undefined ? {} : { since }),
          ...(limit === undefined ? {} : { limit }),
        });
      }

      case "search": {
        const ctx = this.resolve(request.network);
        const room = p<string>("room");
        const limit = p<number>("limit");
        return await ctx.network.search(p<string>("query") ?? "", {
          ...(room === undefined ? {} : { room }),
          ...(limit === undefined ? {} : { limit }),
        });
      }

      case "health":
        return this.resolve(request.network).network.health();

      case "forecastDelivery":
        return await this.resolve(request.network).network.forecastDelivery(
          p<string>("room") ?? "",
          p<string[]>("agents") ?? [],
        );

      case "inbox": {
        const ctx = this.resolve(request.network);
        const room = p<string>("room");
        const needs = p<string>("needs");
        // `tag` was honoured in direct mode and dropped here, so the same
        // command filtered or did not depending on whether a daemon happened to
        // be running. Both backends answer the same question or neither does.
        const tag = p<string>("tag");
        return ctx.network.inbox({
          ...(room === undefined ? {} : { room }),
          ...(needs === undefined ? {} : { needs }),
          ...(tag === undefined ? {} : { tag }),
        });
      }

      case "inboxDrain": {
        const ctx = this.resolve(request.network);
        const ids = p<string[]>("ids") ?? [];
        const drained = ctx.network.drainInbox(ids);
        for (const room of new Set(p<string[]>("rooms") ?? [])) {
          await ctx.network.publishReceipt(room).catch(() => undefined);
        }
        return drained;
      }

      case "receipts":
        return await this.resolve(request.network).network.readReceipts(p<string>("room") ?? "");

      case "mentions":
        return await this.resolve(request.network).network.discoverMentions();

      case "waitInbox": {
        const ctx = this.resolve(request.network);
        return await ctx.network.waitForInbox(
          (params["query"] ?? {}) as Parameters<Network["waitForInbox"]>[0],
        );
      }

      case "agents":
        return await this.resolve(request.network).network.listAgentDirectory();

      case "profileGet":
        return await this.resolve(request.network).network.getAgentProfile(p<string>("agent"));

      case "profileUpdate": {
        const ctx = this.resolve(request.network);
        const published = await ctx.network.publishAgentProfile(
          (params["input"] ?? {}) as Parameters<Network["publishAgentProfile"]>[0],
        );
        return { published, profile: await ctx.network.getAgentProfile() };
      }

      case "sealCheck":
        return await this.resolve(request.network).network.sealDecision(p<string>("room") ?? "");

      case "seal": {
        const ctx = this.resolve(request.network);
        const result = await ctx.network.seal(p<string>("room") ?? "");
        if (result.sealed > 0) this.log(`[${ctx.config.id}] ${JSON.stringify(result)}`);
        return result;
      }

      case "announce": {
        const ctx = this.resolve(request.network);
        const session = p<string>("session");
        return {
          published: await ctx.network.announce(
            p<"live" | "away">("status") ?? "live",
            session === undefined ? {} : { session },
          ),
        };
      }

      case "handshake": {
        const ctx = this.resolve(request.network);
        const result = await ctx.network.handshake(
          (params["input"] ?? {}) as Parameters<Network["handshake"]>[0],
        );
        // A handshake subscribes to the room it greets in when it has to, so
        // the new subscription has to outlive this process like any other join.
        await this.persistSubscriptions();
        // The point of a handshake is the reply, so drop to the hot cadence
        // rather than letting an idle poll interval decide when it lands.
        ctx.loop.wake("handshake");
        return result;
      }

      case "presence": {
        const ctx = this.resolve(request.network);
        const rows = await ctx.network.presenceRoster();
        // Only this agent's own row is answered from the daemon rather than the
        // record: the daemon knows whether a session is attached right now,
        // which no published card can.
        return rows.map((row) =>
          row.id === ctx.network.identity.id
            ? { ...row, status: this.sessionLive ? ("live" as const) : ("away" as const) }
            : row,
        );
      }
    }
  }

  /**
   * Publish an online/offline transition.
   *
   * Transition only, never a heartbeat: a beat would generate more commits than
   * the actual conversation does.
   */
  private async publishPresence(status: "live" | "away"): Promise<void> {
    for (const ctx of this.networks.values()) {
      try {
        const published = await ctx.network.publishAgentCard({ presence: status });
        if (published) this.log(`[${ctx.config.id}] presence → ${status}`);
      } catch (error) {
        this.log(`presence publish failed: ${describeError(error)}`);
      }
    }
  }

  /** Refresh allowlisted runtime facts without making connection depend on them. */
  private async publishProfiles(environment: AgentRuntimeEnvironment): Promise<void> {
    for (const ctx of this.networks.values()) {
      try {
        const published = await ctx.network.publishAgentProfile({}, environment);
        if (published) this.log(`[${ctx.config.id}] agent profile refreshed`);
      } catch (error) {
        this.log(`agent profile publish failed: ${describeError(error)}`);
      }
    }
  }

  private async onSessionChange(): Promise<void> {
    if (this.sessionLive) {
      if (this.presenceAwayTimer !== null) clearTimeout(this.presenceAwayTimer);
      this.presenceAwayTimer = null;
      await this.publishPresence("live");
      for (const ctx of this.networks.values()) ctx.loop.wake("session opened");
      return;
    }

    if (this.stopping) {
      if (this.presenceAwayTimer !== null) clearTimeout(this.presenceAwayTimer);
      this.presenceAwayTimer = null;
      await this.publishPresence("away");
      return;
    }

    // Editors routinely reconnect MCP during reloads. Publishing away/live for
    // that brief gap adds two contended main commits without useful signal.
    if (this.presenceAwayTimer !== null) return;
    this.presenceAwayTimer = setTimeout(() => {
      this.presenceAwayTimer = null;
      if (!this.sessionLive) void this.publishPresence("away");
    }, this.options.presenceAwayGraceMs ?? 30_000);
    this.presenceAwayTimer.unref();
  }

  /** Persist subscription changes made through the socket back to config.yaml. */
  private async persistSubscriptions(): Promise<void> {
    if (this.config === null) return;
    for (const ctx of this.networks.values()) {
      this.config.networks[ctx.config.id] = ctx.network.config;
    }
    const { saveConfig } = await import("@komnet/core");
    await saveConfig(this.layout.configPath, this.config);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log("shutting down");

    for (const ctx of this.networks.values()) ctx.loop.stop();

    // Capture the sockets before clearing so they can still be destroyed after
    // the final best-effort away transition.
    const open = [...this.sessions];
    const awayPending = this.presenceAwayTimer !== null;
    if (this.presenceAwayTimer !== null) clearTimeout(this.presenceAwayTimer);
    this.presenceAwayTimer = null;
    if (open.length > 0 || awayPending) {
      this.sessions.clear();
      // Publish 'away' while we can still reach the remote, so a peer does not
      // see this agent as live until its card happens to be rewritten.
      await this.publishPresence("away").catch(() => undefined);
    }
    for (const socket of open) socket.destroy();

    if (this.server !== null) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = null;
    }
    await unlink(this.socketPath).catch(() => undefined);
    for (const ctx of this.networks.values()) ctx.network.close();
    this.networks.clear();
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function summariseTitle(messages: readonly Message[]): string {
  if (messages.length === 1) {
    const only = messages[0] as Message;
    return only.header.needs === "human"
      ? `${only.header.from} needs a decision`
      : `${only.header.from} in #${only.header.room}`;
  }
  const rooms = new Set(messages.map((m) => m.header.room));
  return `${String(messages.length)} messages in ${[...rooms].map((r) => `#${r}`).join(", ")}`;
}

function summariseBody(messages: readonly Message[]): string {
  const first = messages[0] as Message;
  const line = first.body.trim().split("\n")[0] ?? "";
  return messages.length === 1 ? line : `${line} (+${String(messages.length - 1)} more)`;
}

/**
 * How often the daemon looks for work that has stopped moving.
 *
 * The scan re-reads every subscribed room, so it is deliberately coarse. The
 * shortest silence threshold the protocol allows is a minute, but the default
 * is a day — five-minute granularity is far finer than the signal it reports.
 */
const STALL_SCAN_INTERVAL_MS = 5 * 60_000;

/** Meta key holding the task/health pairs already reported, so each fires once. */
const STALLED_META_KEY = "notifiedStalledTasks";

/**
 * Decode the reported set defensively. A malformed or absent value means
 * "nothing reported yet", which re-notifies at worst — never silence.
 */
function decodeAnnounced(raw: string | null): string[] {
  if (raw === null || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function describeStalledTask(entry: AgendaEntry): string {
  const task = entry.status.task;
  return `${entry.status.health} · ${task.title} (#${entry.room})`;
}
