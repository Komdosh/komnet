import {
  Layout,
  Network,
  ReviewRepositoryResolver,
  liveSessions,
  loadConfig,
  observedPresenceStatus,
  resolveNetwork,
  saveConfig,
  type KomnetConfig,
  type NetworkConfig,
} from "@komnet/core";
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
  private readonly config: KomnetConfig;
  private readonly netConfig: NetworkConfig;
  private readonly network: Network;

  constructor(layout: Layout, config: KomnetConfig, netConfig: NetworkConfig) {
    this.layout = layout;
    this.config = config;
    this.netConfig = netConfig;
    this.network = Network.open(layout, netConfig, config.agent);
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
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
        result = await net.createRoom(p<string>("room") ?? "", {
          ...(title === undefined ? {} : { title }),
          ...(purpose === undefined ? {} : { purpose }),
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
        result = await net.listAgents();
        break;
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
      case "presence": {
        const cards = await net.listAgents();
        result = cards.map((card) => ({
          id: card.id,
          status: observedPresenceStatus(card.presence),
          lastSeen: card.presence.lastSeen,
          human: card.human.name,
          timezone: card.human.timezone,
          tool: card.tool,
          sessions: liveSessions(card.presence).length,
        }));
        break;
      }
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
}

export interface OpenBackendOptions {
  layout?: Layout;
  network?: string;
  /** Skip the daemon even if one is running. Used by tests. */
  forceDirect?: boolean;
}

export async function openBackend(options: OpenBackendOptions = {}): Promise<Backend> {
  const layout = options.layout ?? new Layout();

  if (options.forceDirect !== true) {
    const client = await DaemonClient.tryConnect(layout.socketPath);
    if (client !== null) {
      await client.openSession().catch(() => undefined);
      return new DaemonBackend(client);
    }
  }

  const config = await loadConfig(layout.configPath);
  if (config === null) {
    throw new Error(
      `komnet is not configured (${layout.configPath} not found). Run: komnet init --repo <url>`,
    );
  }
  return new DirectBackend(layout, config, resolveNetwork(config, options.network));
}
