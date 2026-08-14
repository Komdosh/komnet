import {
  Layout,
  Network,
  ReviewRepositoryResolver,
  loadConfig,
  resolveNetwork,
  saveConfig,
  type ApprovalKind,
  type AgentRuntimeEnvironment,
  type KomnetConfig,
  type NetworkConfig,
} from "@komnet/core";
import { stat } from "node:fs/promises";

import { DaemonClient } from "./client.ts";
import type { Method } from "./protocol.ts";

/**
 * How the MCP server reaches komnet.
 *
 * Prefers the daemon, for two reasons that matter:
 *  - **presence becomes accurate** — an MCP server's lifetime IS an agent
 *    session's lifetime, so declaring the connection tells the network when
 *    this agent is genuinely live;
 *  - **inbox state gets a single writer**, instead of the daemon and this
 *    process both marking items processed.
 *
 * Falls back to direct mode so an editor without a running daemon still works
 * (ADR 0005) — at the cost of nothing accumulating between sessions.
 */
/**
 * How long a direct-mode answer may be, before the next read pulls again.
 *
 * Roughly the daemon's hot poll: fresh enough that an agent watching a
 * conversation is not answered from a view it has already outrun, loose enough
 * that a burst of calls in one turn is one `ls-remote` rather than ten.
 */
const DIRECT_FRESHNESS_MS = 10_000;

export interface Backend {
  readonly mode: "daemon" | "direct";
  /**
   * `network` overrides which network this ONE call is about.
   *
   * A session binds to a network when it opens, which is right for the common
   * case and wrong for the one that made people restart editors: an agent whose
   * work spans two transport repos had no way to look at the second without
   * reopening its MCP server against a different default. The binding stays the
   * default; this makes it a per-call decision, so switching costs a parameter
   * rather than a session.
   */
  call<T = unknown>(method: string, params?: Record<string, unknown>, network?: string): Promise<T>;
  /** Every network configured on this machine, current one first. */
  networks(): Promise<NetworkSummary[]>;
  close(): Promise<void>;
}

/** One configured network, as the surfaces list it. */
export interface NetworkSummary {
  id: string;
  remote: string;
  subscriptions: string[];
  /** True for the network a command with no `--network` resolves to. */
  current: boolean;
}

function summariseNetworks(config: KomnetConfig, currentId: string): NetworkSummary[] {
  return Object.values(config.networks)
    .map((net) => ({
      id: net.id,
      remote: net.remote,
      subscriptions: [...net.subscriptions],
      current: net.id === currentId,
    }))
    .sort((a, b) => (a.current === b.current ? a.id.localeCompare(b.id) : a.current ? -1 : 1));
}

class DaemonBackend implements Backend {
  readonly mode = "daemon" as const;
  private readonly client: DaemonClient;
  /**
   * The network every request is pinned to.
   *
   * Load-bearing, and it was missing. The daemon serves every configured
   * network and picks its default when a request names none — so `--network x`
   * resolved `x` in direct mode and was **silently dropped** in daemon mode,
   * answering about the default network instead. A watcher armed on one
   * conversation reported another one quiet, which is indistinguishable from
   * nobody talking. Undefined still means "the daemon's default", which is what
   * a command with no `--network` asks for.
   */
  private readonly network: string | undefined;

  constructor(client: DaemonClient, network?: string) {
    this.client = client;
    this.network = network;
  }

  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
    network?: string,
  ): Promise<T> {
    return await this.client.request<T>(method as Method, params, network ?? this.network);
  }

  async networks(): Promise<NetworkSummary[]> {
    return await this.client.request<NetworkSummary[]>("networks", {}, this.network);
  }

  async close(): Promise<void> {
    // Marks this agent away; the daemon publishes the transition.
    await this.client.request("sessionClose").catch(() => undefined);
    this.client.close();
  }
}

class DirectBackend implements Backend {
  readonly mode = "direct" as const;
  private readonly layout: Layout;
  private config: KomnetConfig;
  private netConfig: NetworkConfig;
  private network: Network;
  /** Which network was asked for, so a reload re-resolves the same one. */
  private readonly requested: string | undefined;
  /** Config mtime this backend was built from. See `refreshConfig`. */
  private configMtimeMs: number;
  /** When this backend last pulled, and the pull in flight. See `ensureFresh`. */
  private pulledAt = 0;
  private pulling: Promise<void> | null = null;
  /**
   * Other configured networks, opened on first use.
   *
   * The daemon has always had every network open at once; direct mode had one,
   * so the same `--network other` worked with a daemon and failed without.
   * Opened lazily because most sessions only ever touch one, and each open
   * costs a git handle and a SQLite connection.
   */
  private readonly others = new Map<
    string,
    { network: Network; pulledAt: number; pulling: Promise<void> | null }
  >();

  constructor(
    layout: Layout,
    config: KomnetConfig,
    netConfig: NetworkConfig,
    options: { requested?: string; mtimeMs?: number } = {},
  ) {
    this.layout = layout;
    this.config = config;
    this.netConfig = netConfig;
    this.network = Network.open(layout, netConfig, config.agent);
    this.requested = options.requested;
    this.configMtimeMs = options.mtimeMs ?? 0;
  }

  /**
   * Pick up a config that changed under a long-lived process.
   *
   * An MCP server lives for the whole editor session, so binding config once
   * meant it could serve a network the config no longer contained: a reader saw
   * `network=komnet-test, pending=0` from MCP while the CLI saw a different
   * network with 39 unread. Both were "correct" about different worlds.
   *
   * Keyed on mtime so the common case is one `stat`, not a YAML parse.
   */
  private async refreshConfig(): Promise<void> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(this.layout.configPath)).mtimeMs;
    } catch {
      return; // Config vanished mid-session; keep serving what we have.
    }
    if (mtimeMs === this.configMtimeMs) return;
    this.configMtimeMs = mtimeMs;

    const fresh = await loadConfig(this.layout.configPath);
    if (fresh === null) return;
    const resolved = resolveNetwork(fresh, this.requested);
    const rebind =
      resolved.id !== this.netConfig.id ||
      resolved.remote !== this.netConfig.remote ||
      fresh.agent.id !== this.config.agent.id;

    this.config = fresh;
    this.netConfig = resolved;
    if (rebind) {
      this.network.close();
      this.network = Network.open(this.layout, resolved, fresh.agent);
    } else {
      // Same network: adopt subscription changes without discarding the cache.
      this.network.config.subscriptions = [...resolved.subscriptions];
    }
  }

  /**
   * Pull before answering. Best effort, and at most once per window.
   *
   * With a daemon, every read is a cache hit by design, because the daemon is
   * the thing keeping the cache true. With no daemon there is no such thing: a
   * read answered from the cache is answering about a network nobody has looked
   * at. That is not merely stale — it cannot become right, so an agent polling
   * `komnet inbox` in a shell loop was told "inbox empty" indefinitely while the
   * messages sat on the remote, with nothing in the output to suggest the loop
   * was pointless. `komnet sync` fixed it, which is exactly the step the loop
   * existed to avoid needing.
   *
   * The window bounds what that costs. A one-shot command lives for a second,
   * so it pulls once however many calls it makes (the inbox reads health and
   * items); a direct-mode MCP server lives for the session, so it re-pulls as
   * its answers age instead of pulling once at startup and going quiet. Failure
   * counts as a pull, so an unreachable remote is not retried per call — the
   * read still answers from the cache, and `health` says why.
   */
  private async ensureFresh(): Promise<void> {
    if (this.pulling !== null) {
      await this.pulling;
      return;
    }
    if (Date.now() - this.pulledAt < DIRECT_FRESHNESS_MS) return;

    const pull = (async () => {
      try {
        const report = await this.network.sync();
        // Keep the filesystem surface (ADR 0009) in step when something landed.
        if (report.delivered > 0) await this.network.writeInboxFiles();
      } catch {
        // Recorded against the network's health, which every read carries.
      } finally {
        this.pulledAt = Date.now();
      }
    })();
    this.pulling = pull;
    try {
      await pull;
    } finally {
      this.pulling = null;
    }
  }

  /** Every configured network, so a caller can fan out without reading config. */
  async networks(): Promise<NetworkSummary[]> {
    await this.refreshConfig();
    return summariseNetworks(this.config, this.netConfig.id);
  }

  /**
   * The network one call is about: the bound one, or another by id.
   *
   * Another network gets its own freshness pull the first time it is touched,
   * for the reason the bound one does (`ensureFresh`): with no daemon nothing
   * else is pulling, and a cross-network read answered from a cache nobody
   * filled is the failure this whole path exists to prevent.
   */
  private async networkFor(id: string | undefined): Promise<Network> {
    if (id === undefined || id === this.netConfig.id) return this.network;
    let entry = this.others.get(id);
    if (entry === undefined) {
      const netConfig = resolveNetwork(this.config, id);
      entry = {
        network: Network.open(this.layout, netConfig, this.config.agent),
        pulledAt: 0,
        pulling: null,
      };
      this.others.set(id, entry);
    }
    // The pull is awaited, and shared. A cross-network read fires `health` and
    // `inbox` concurrently, so without joining the in-flight pull the second
    // call sees the network as already-freshened and reads the cache **before**
    // the first call's sync lands — an empty inbox on a network that has mail,
    // which is the exact failure this whole path exists to prevent.
    await this.freshen(entry);
    return entry.network;
  }

  private async freshen(entry: {
    network: Network;
    pulledAt: number;
    pulling: Promise<void> | null;
  }): Promise<void> {
    if (entry.pulling !== null) {
      await entry.pulling;
      return;
    }
    if (Date.now() - entry.pulledAt < DIRECT_FRESHNESS_MS) return;
    const pull = (async () => {
      try {
        const report = await entry.network.sync();
        if (report.delivered > 0) await entry.network.writeInboxFiles();
      } catch {
        // Recorded against that network's health, which its reads carry.
      } finally {
        entry.pulledAt = Date.now();
      }
    })();
    entry.pulling = pull;
    try {
      await pull;
    } finally {
      entry.pulling = null;
    }
  }

  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
    network?: string,
  ): Promise<T> {
    await this.refreshConfig();
    // `sync` pulls on its own; everything else has to be told to.
    if (method !== "sync" && (network === undefined || network === this.netConfig.id)) {
      await this.ensureFresh();
    }
    const p = <V>(key: string): V | undefined => params[key] as V | undefined;
    const net = await this.networkFor(network);
    let result: unknown;

    switch (method) {
      case "status":
        result = await net.status();
        break;
      case "sync":
        result = await net.sync();
        await net.writeInboxFiles();
        break;
      case "rooms":
        result = await net.listRooms();
        break;
      case "roomShow":
        result = await net.readRoomConfig(p<string>("room") ?? "");
        break;
      case "roomCreate": {
        const title = p<string>("title");
        const purpose = p<string>("purpose");
        const replyBudget = p<number>("replyBudget");
        result = await net.createRoom(p<string>("room") ?? "", {
          ...(title === undefined ? {} : { title }),
          ...(purpose === undefined ? {} : { purpose }),
          ...(replyBudget === undefined ? {} : { replyBudget }),
        });
        await this.persist();
        break;
      }
      case "roomJoin":
        await net.joinRoom(p<string>("room") ?? "");
        await this.persist();
        result = { joined: p<string>("room") };
        break;
      case "roomLeave":
        await net.leaveRoom(p<string>("room") ?? "");
        await this.persist();
        result = { left: p<string>("room") };
        break;
      case "send":
        result = await net.send(
          p<string>("room") ?? "",
          (params["input"] ?? {}) as Parameters<Network["send"]>[1],
        );
        break;
      case "answer":
        result = await net.answer(p<string>("messageId") ?? "", p<string>("body") ?? "");
        break;
      case "reviewRequest":
        result = await net.requestReview(
          p<string>("room") ?? "",
          (params["input"] ?? {}) as Parameters<Network["requestReview"]>[1],
        );
        break;
      case "reviewUpdate":
        result = await net.updateReview(
          p<string>("room") ?? "",
          p<string>("reviewId") ?? "",
          (params["input"] ?? {}) as Parameters<Network["updateReview"]>[2],
        );
        break;
      case "reviewPrepare": {
        const fresh = await loadConfig(this.layout.configPath);
        if (fresh === null) throw new Error(`no config at ${this.layout.configPath}`);
        const reviewId = p<string>("reviewId") ?? "";
        const status = (await net.listReviewTasks(p<string>("room") ?? "")).find(
          (candidate) => candidate.review.id === reviewId,
        );
        if (status === undefined) throw new Error(`no review task ${reviewId}`);
        result = await new ReviewRepositoryResolver(this.layout, fresh).prepare(
          status.review,
          net.identity.id,
        );
        break;
      }
      case "reviewRelease": {
        const fresh = await loadConfig(this.layout.configPath);
        if (fresh === null) throw new Error(`no config at ${this.layout.configPath}`);
        result = await new ReviewRepositoryResolver(this.layout, fresh).release(
          p<string>("reviewId") ?? "",
          net.identity.id,
        );
        break;
      }
      case "reviews":
        result = await net.listReviewTasks(p<string>("room") ?? "");
        break;
      case "taskCreate":
        result = await net.createTask(
          p<string>("room") ?? "",
          (params["input"] ?? {}) as Parameters<Network["createTask"]>[1],
        );
        break;
      case "taskClaim":
        result = await net.claimTask(
          p<string>("room") ?? "",
          p<string>("taskId") ?? "",
          p<string>("body") ?? "",
        );
        break;
      case "taskUpdate":
        result = await net.updateTask(
          p<string>("room") ?? "",
          p<string>("taskId") ?? "",
          (params["input"] ?? {}) as Parameters<Network["updateTask"]>[2],
        );
        break;
      case "tasks":
        result = await net.listTasks(p<string>("room") ?? "");
        break;
      case "claim": {
        const ttlSeconds = p<number>("ttlSeconds");
        const note = p<string>("note");
        result = await net.claimResource(p<string>("room") ?? "", p<string>("resource") ?? "", {
          ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
          ...(note === undefined ? {} : { note }),
        });
        break;
      }
      case "claimRelease":
        result = {
          released: await net.releaseResource(p<string>("room") ?? "", p<string>("resource") ?? ""),
        };
        break;
      case "claims":
        result = await net.listClaims(p<string>("room") ?? "");
        break;
      case "taskShow":
        result = await net.showTask(p<string>("room") ?? "", p<string>("taskId") ?? "");
        break;
      case "policy":
        result = await net.policy();
        break;
      case "approvals":
        result = await net.listApprovals();
        break;
      case "approve": {
        const note = p<string>("note");
        result = await net.approveInboundWork(
          (p<string>("kind") ?? "task") as ApprovalKind,
          p<string>("room") ?? "",
          p<string>("id") ?? "",
          ...(note === undefined ? [] : [note]),
        );
        break;
      }
      case "approveRevoke":
        result = {
          revoked: await net.revokeApproval(
            (p<string>("kind") ?? "task") as ApprovalKind,
            p<string>("id") ?? "",
          ),
        };
        break;
      case "agenda": {
        const limit = p<number>("limit");
        const includeUnclaimed = p<boolean>("includeUnclaimed");
        result = await net.agenda({
          ...(limit === undefined ? {} : { limit }),
          ...(includeUnclaimed === undefined ? {} : { includeUnclaimed }),
        });
        break;
      }
      case "resume": {
        const limit = p<number>("limit");
        result = limit === undefined ? await net.resume() : await net.resume(limit);
        break;
      }
      case "read": {
        const limit = p<number>("limit");
        const thread = p<string>("thread");
        result = await net.read(p<string>("room") ?? "", {
          ...(limit === undefined ? {} : { limit }),
          ...(thread === undefined ? {} : { thread }),
        });
        break;
      }
      case "history": {
        const since = p<string>("since");
        const limit = p<number>("limit");
        result = await net.history(p<string>("room") ?? "", {
          ...(since === undefined ? {} : { since }),
          ...(limit === undefined ? {} : { limit }),
        });
        break;
      }
      case "search": {
        const room = p<string>("room");
        const limit = p<number>("limit");
        result = await net.search(p<string>("query") ?? "", {
          ...(room === undefined ? {} : { room }),
          ...(limit === undefined ? {} : { limit }),
        });
        break;
      }
      case "health":
        result = net.health();
        break;
      case "outbox":
        result = await net.outbox();
        break;
      case "surroundings":
        result = net.surroundings();
        break;
      case "trace":
        result = await net.trace(p<string>("messageId") ?? "");
        break;
      case "forecastDelivery":
        result = await net.forecastDelivery(p<string>("room") ?? "", p<string[]>("agents") ?? []);
        break;
      case "inbox": {
        const room = p<string>("room");
        const needs = p<string>("needs");
        const tag = p<string>("tag");
        result = net.inbox({
          ...(room === undefined ? {} : { room }),
          ...(needs === undefined ? {} : { needs }),
          ...(tag === undefined ? {} : { tag }),
        });
        break;
      }
      case "inboxDrain": {
        const drained = net.drainInbox(p<string[]>("ids") ?? []);
        // Publishing the receipt is part of draining: draining is the moment
        // "I have handled this" becomes true, and a receipt written at any
        // other moment would be claiming something that is not.
        for (const room of new Set(p<string[]>("rooms") ?? [])) {
          await net.publishReceipt(room).catch(() => undefined);
        }
        result = drained;
        break;
      }
      case "receipts":
        result = await net.readReceipts(p<string>("room") ?? "");
        break;
      case "mentions":
        result = await net.discoverMentions();
        break;
      case "waitInbox":
        result = await net.waitForInbox(
          (params["query"] ?? {}) as Parameters<Network["waitForInbox"]>[0],
        );
        break;
      case "agents":
        result = await net.listAgentDirectory();
        break;
      case "profileGet":
        result = await net.getAgentProfile(p<string>("agent"));
        break;
      case "profileUpdate": {
        const published = await net.publishAgentProfile(
          (params["input"] ?? {}) as Parameters<Network["publishAgentProfile"]>[0],
        );
        result = { published, profile: await net.getAgentProfile() };
        break;
      }
      case "sealCheck":
        result = await net.sealDecision(p<string>("room") ?? "");
        break;
      case "seal":
        result = await net.seal(p<string>("room") ?? "");
        break;
      case "announce": {
        const session = p<string>("session");
        result = {
          published: await net.announce(
            p<"live" | "away">("status") ?? "live",
            session === undefined ? {} : { session },
          ),
        };
        break;
      }
      case "handshake":
        result = await net.handshake(
          (params["input"] ?? {}) as Parameters<Network["handshake"]>[0],
        );
        await this.persist();
        break;
      case "presence":
        result = await net.presenceRoster();
        break;
      default:
        throw new Error(`method '${method}' is not available in direct mode`);
    }
    return result as T;
  }

  private async persist(): Promise<void> {
    this.config.networks[this.netConfig.id] = this.network.config;
    await saveConfig(this.layout.configPath, this.config);
  }

  async close(): Promise<void> {
    this.network.close();
    for (const { network } of this.others.values()) network.close();
    this.others.clear();
  }

  async publishConnectionProfile(environment: AgentRuntimeEnvironment): Promise<void> {
    await this.network.publishAgentProfile({}, environment);
  }
}

export interface OpenBackendOptions {
  layout?: Layout;
  network?: string;
  /** Skip the daemon even if one is running. Used by tests. */
  forceDirect?: boolean;
  /**
   * Connection surface recorded in the agent's advisory profile.
   *
   * Over the daemon this rides on declaring a session, so it is only recorded
   * when `session` is also set; in direct mode it is published on connect.
   */
  client?: string;
  /**
   * Declare this connection a long-lived agent session.
   *
   * Off by default, and that default is load-bearing. A session is a process
   * whose lifetime IS the session's — the MCP server, `komnet watch` — because
   * the daemon stamps this agent's card when the first one attaches, and that
   * stamp is a commit and a push on `main`. Declaring it for every one-shot
   * command wrote `live`, and then `away` when the second-long "session"
   * dropped, per invocation and per network (ADR 0022).
   */
  session?: boolean;
}

export async function openBackend(options: OpenBackendOptions = {}): Promise<Backend> {
  const layout = options.layout ?? new Layout();
  const environment: AgentRuntimeEnvironment | undefined =
    options.client === undefined
      ? undefined
      : {
          client: options.client,
          platform: process.platform,
          architecture: process.arch,
        };

  if (options.forceDirect !== true) {
    const client = await DaemonClient.tryConnect(layout.socketPath);
    if (client !== null) {
      // A daemon serving a different identity than this home resolves to is not
      // a faster path to the same answer — it is a different agent's view of
      // the network. Refusing to use it beats silently reading someone else's
      // inbox; falling through opens this home directly, which is correct.
      const serves = await client.identity().catch(() => null);
      const wanted = (await loadConfig(layout.configPath))?.agent.id;
      if (serves === null || wanted === undefined || serves === wanted) {
        if (options.session === true) await client.openSession(environment).catch(() => undefined);
        return new DaemonBackend(client, options.network);
      }
      client.close();
    }
  }

  const config = await loadConfig(layout.configPath);
  if (config === null) {
    throw new Error(
      `komnet is not configured (${layout.configPath} not found). Run: komnet init --repo <url>`,
    );
  }
  const mtimeMs = await stat(layout.configPath)
    .then((info) => info.mtimeMs)
    .catch(() => 0);
  const backend = new DirectBackend(layout, config, resolveNetwork(config, options.network), {
    ...(options.network === undefined ? {} : { requested: options.network }),
    mtimeMs,
  });
  // Description is useful but advisory. A temporary push failure must not make
  // an editor lose the entire MCP connection; record-outbox sync retries it.
  if (environment !== undefined) {
    await backend.publishConnectionProfile(environment).catch(() => undefined);
  }
  return backend;
}
