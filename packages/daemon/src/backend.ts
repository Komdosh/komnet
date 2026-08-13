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
export interface Backend {
  readonly mode: "daemon" | "direct";
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

class DaemonBackend implements Backend {
  readonly mode = "daemon" as const;
  private readonly client: DaemonClient;

  constructor(client: DaemonClient) {
    this.client = client;
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return await this.client.request<T>(method as Method, params);
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

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.refreshConfig();
    const p = <V>(key: string): V | undefined => params[key] as V | undefined;
    const net = this.network;
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
  /** Connection surface recorded in the agent's advisory profile. */
  client?: string;
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
      await client.openSession(environment).catch(() => undefined);
      return new DaemonBackend(client);
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
