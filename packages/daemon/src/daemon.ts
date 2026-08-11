import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import {
  Layout,
  Network,
  loadConfig,
  type CadencePolicy,
  type KomnetConfig,
  type NetworkConfig,
  type SyncReport,
} from "@kom-net/core";
import type { Message } from "@kom-net/protocol";

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
  private nextConnectionId = 1;

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
        onReport: (report) => this.onReport(netConfig.id, network, report),
        onError: (error) => this.log(`sync failed [${netConfig.id}]: ${describe(error)}`),
        ...(this.options.cadence === undefined ? {} : { cadence: this.options.cadence }),
        log: (message) => this.log(`[${netConfig.id}] ${message}`),
      });
      this.networks.set(netConfig.id, { config: netConfig, network, loop });
    }
  }

  /**
   * React to a completed sync: stage the inbox on disk and decide what
   * deserves a human's attention.
   */
  private async onReport(networkId: string, network: Network, report: SyncReport): Promise<void> {
    if (report.delivered > 0) {
      this.log(`[${networkId}] delivered ${String(report.delivered)} message(s)`);
      await network.writeInboxFiles().catch((error: unknown) => {
        this.log(`inbox render failed: ${describe(error)}`);
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
      .catch((error: unknown) => this.log(`notify failed: ${describe(error)}`));
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
      throw new Error(`another kom-net daemon is already running on ${path}`);
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
        socket.end(encode({ id: 0, ok: false, error: { message: describe(error) } }));
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
        error: { message: describe(error), ...(code === undefined ? {} : { code }) },
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
        const room = await ctx.network.createRoom(p<string>("room") ?? "", {
          ...(title === undefined ? {} : { title }),
          ...(purpose === undefined ? {} : { purpose }),
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
        const message = await ctx.network.answer(
          p<string>("messageId") ?? "",
          p<string>("body") ?? "",
          p<boolean>("asHuman") === true,
        );
        ctx.loop.wake("local answer");
        return message;
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

      case "inbox": {
        const ctx = this.resolve(request.network);
        const room = p<string>("room");
        const needs = p<string>("needs");
        return ctx.network.inbox({
          ...(room === undefined ? {} : { room }),
          ...(needs === undefined ? {} : { needs }),
        });
      }

      case "inboxDrain": {
        const ctx = this.resolve(request.network);
        const ids = p<string[]>("ids") ?? [];
        return ctx.network.drainInbox(ids);
      }

      case "agents":
        return await this.resolve(request.network).network.listAgents();

      case "presence": {
        const ctx = this.resolve(request.network);
        const cards = await ctx.network.listAgents();
        return cards.map((card) => ({
          id: card.id,
          status:
            card.id === ctx.network.identity.id && this.sessionLive ? "live" : card.presence.status,
          lastSeen: card.presence.lastSeen,
          human: card.human.name,
          timezone: card.human.timezone,
          tool: card.tool,
        }));
      }
    }
  }

  /**
   * Publish an online/offline transition.
   *
   * Transition only, never a heartbeat: a beat would generate more commits than
   * the actual conversation does.
   */
  private async onSessionChange(): Promise<void> {
    const status = this.sessionLive ? "live" : "away";
    for (const ctx of this.networks.values()) {
      try {
        const published = await ctx.network.publishAgentCard({ presence: status });
        if (published) this.log(`[${ctx.config.id}] presence → ${status}`);
      } catch (error) {
        this.log(`presence publish failed: ${describe(error)}`);
      }
      if (this.sessionLive) ctx.loop.wake("session opened");
    }
  }

  /** Persist subscription changes made through the socket back to config.yaml. */
  private async persistSubscriptions(): Promise<void> {
    if (this.config === null) return;
    for (const ctx of this.networks.values()) {
      this.config.networks[ctx.config.id] = ctx.network.config;
    }
    const { saveConfig } = await import("@kom-net/core");
    await saveConfig(this.layout.configPath, this.config);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log("shutting down");

    for (const ctx of this.networks.values()) ctx.loop.stop();

    // Capture the sockets BEFORE clearing: `onSessionChange` reads `sessions`
    // to decide the presence transition, so the set must be empty by then — but
    // we still need the handles afterwards to close the connections.
    const open = [...this.sessions];
    if (open.length > 0) {
      this.sessions.clear();
      // Publish 'away' while we can still reach the remote, so a peer does not
      // see this agent as live until its card happens to be rewritten.
      await this.onSessionChange().catch(() => undefined);
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
