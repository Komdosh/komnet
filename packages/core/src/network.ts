import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  MAIN_REF,
  agentCardPath,
  createMessage,
  isAddressedTo,
  isMessagePath,
  messagePath,
  parseMessage,
  roomConfigPath,
  roomRef,
  threadOrder,
  ulid,
  type AuthorKind,
  type Message,
  type MessageKind,
  type Needs,
  type Priority,
} from "@kom-net/protocol";

import {
  cardFromIdentity,
  parseAgentCard,
  serializeAgentCard,
  type AgentCard,
} from "./agent/card.ts";
import type { AgentIdentity, NetworkConfig } from "./config.ts";
import { SecretDetectedError } from "./errors.ts";
import { GitRunner } from "./git/runner.ts";
import { Repo } from "./git/repo.ts";
import { Layout } from "./layout.ts";
import { FileLock } from "./lock.ts";
import {
  createRoomConfig,
  parseRoomConfig,
  serializeRoomConfig,
  type RoomConfig,
} from "./room/config.ts";
import { RoomStore } from "./room/store.ts";
import { scanForSecrets, type SecretRule } from "./scanner/secrets.ts";
import { StateDb, type InboxItem, type InboxQuery } from "./state.ts";
import {
  collectRoomUpdate,
  diffRoomHeads,
  type Anomaly,
  type RoomChange,
} from "./sync/detector.ts";

const REMOTE = "origin";

export interface SendInput {
  body: string;
  kind?: MessageKind;
  needs?: Needs;
  mentions?: string[];
  priority?: Priority;
  tags?: string[];
  inReplyTo?: string;
  thread?: string;
  authorKind?: AuthorKind;
  /** Override a secret-scanner block. Recorded permanently in the header. */
  forceUnsafe?: string;
}

export interface SyncReport {
  roomsPolled: number;
  changed: RoomChange[];
  recorded: number;
  delivered: number;
  anomalies: Anomaly[];
  unreadable: { path: string; error: unknown }[];
}

export interface RoomInfo {
  id: string;
  title: string;
  purpose: string;
  status: "open" | "closed";
  subscribed: boolean;
  materialized: boolean;
  pending: number;
}

export interface NetworkStatus {
  networkId: string;
  remote: string;
  agentId: string;
  subscriptions: string[];
  pending: number;
  pendingHuman: number;
  lastSyncAt: string | null;
  heads: Record<string, string>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * One network, on this machine.
 *
 * Operates in **direct mode** (ADR 0005): every mutating call takes an
 * exclusive lock and runs git itself. The daemon will reuse these same methods
 * behind its socket — the logic lives here precisely so CLI and daemon cannot
 * drift apart.
 */
export class Network {
  readonly layout: Layout;
  readonly config: NetworkConfig;
  readonly identity: AgentIdentity;
  readonly repo: Repo;
  readonly state: StateDb;

  private constructor(init: {
    layout: Layout;
    config: NetworkConfig;
    identity: AgentIdentity;
    repo: Repo;
    state: StateDb;
  }) {
    this.layout = init.layout;
    this.config = init.config;
    this.identity = init.identity;
    this.repo = init.repo;
    this.state = init.state;
  }

  get id(): string {
    return this.config.id;
  }

  private get lockPath(): string {
    return join(this.layout.networkDir(this.id), "lock");
  }

  private get recordWorktree(): string {
    return this.layout.recordWorktree(this.id);
  }

  static open(
    layout: Layout,
    config: NetworkConfig,
    identity: AgentIdentity,
    runner: GitRunner = new GitRunner(),
  ): Network {
    return new Network({
      layout,
      config,
      identity,
      repo: new Repo(layout.gitDir(config.id), runner),
      state: StateDb.open(layout.statePath(config.id)),
    });
  }

  /**
   * Clone (or adopt) a transport repository and register this agent on it.
   *
   * Handles the empty-remote case explicitly, because that is the normal state
   * of a private repo someone just created for their team.
   */
  static async init(options: {
    layout: Layout;
    networkId: string;
    remote: string;
    identity: AgentIdentity;
    runner?: GitRunner;
  }): Promise<{ network: Network; createdNetwork: boolean }> {
    const { layout, networkId, remote, identity } = options;
    const runner = options.runner ?? new GitRunner();
    const gitDir = layout.gitDir(networkId);

    const repo = (await exists(gitDir))
      ? new Repo(gitDir, runner)
      : await Repo.cloneBare(remote, gitDir, runner);

    await repo.setFetchScope(REMOTE, []);

    const recordWorktree = layout.recordWorktree(networkId);
    let createdNetwork = false;

    if (!(await exists(recordWorktree))) {
      if (await repo.refExists(MAIN_REF)) {
        await repo.addWorktree(recordWorktree, MAIN_REF);
      } else {
        // Empty remote: bring `main` into existence with the network manifest.
        createdNetwork = true;
        await repo.addOrphanWorktree(recordWorktree, MAIN_REF);
        await repo.commitFile(
          recordWorktree,
          ".komnet/net.yaml",
          `v: 1\nid: ${networkId}\nname: ${networkId}\nprotocol_version: 1\nauthenticity: git\n`,
          "komnet: initialise network",
        );
        await repo.pushNewBranch(recordWorktree, MAIN_REF, REMOTE);
      }
    }

    const config: NetworkConfig = { id: networkId, remote, subscriptions: [] };
    const network = new Network({
      layout,
      config,
      identity,
      repo,
      state: StateDb.open(layout.statePath(networkId)),
    });

    await network.publishAgentCard();
    return { network, createdNetwork };
  }

  /** Publish (or refresh) this agent's card on `main`. Own file only. */
  async publishAgentCard(
    extras: { expertise?: string[]; speaksFor?: string[] } = {},
  ): Promise<void> {
    await FileLock.withLock(this.lockPath, async () => {
      const path = agentCardPath(this.identity.id);
      const card = cardFromIdentity(this.identity, extras);
      const absolute = join(this.recordWorktree, path);
      const existing = (await exists(absolute)) ? await readFile(absolute, "utf8") : null;
      const next = serializeAgentCard(card);
      // Presence timestamps change on every call; rewriting an otherwise
      // identical card would add a commit per invocation for no information.
      if (existing !== null && stripPresence(existing) === stripPresence(next)) return;

      await this.repo.commitFile(
        this.recordWorktree,
        path,
        next,
        `komnet: agent ${this.identity.id}`,
      );
      await this.repo.pushWithRetry(this.recordWorktree, MAIN_REF, { remote: REMOTE });
    });
  }

  async listAgents(): Promise<AgentCard[]> {
    const dir = join(this.recordWorktree, "agents");
    if (!(await exists(dir))) return [];
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir, { withFileTypes: true });
    const cards: AgentCard[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
      try {
        cards.push(parseAgentCard(await readFile(join(dir, entry.name), "utf8")));
      } catch {
        // A malformed card must not make the roster unreadable.
      }
    }
    return cards.sort((a, b) => a.id.localeCompare(b.id));
  }

  // -------------------------------------------------------------------- rooms

  async listRooms(): Promise<RoomInfo[]> {
    const dir = join(this.recordWorktree, "rooms");
    const subscribed = new Set(this.config.subscriptions);
    const infos: RoomInfo[] = [];

    if (await exists(dir)) {
      const { readdir } = await import("node:fs/promises");
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const configPath = join(dir, entry.name, "room.yaml");
        let room: RoomConfig;
        try {
          room = parseRoomConfig(await readFile(configPath, "utf8"));
        } catch {
          continue;
        }
        infos.push({
          id: room.id,
          title: room.title,
          purpose: room.purpose,
          status: room.status,
          subscribed: subscribed.has(room.id),
          materialized: await exists(this.layout.roomWorktree(this.id, room.id)),
          pending: this.state.pendingCount(room.id),
        });
      }
    }
    return infos.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Create a room: an orphan branch for its log, plus its config on `main`. */
  async createRoom(
    roomId: string,
    options: { title?: string; purpose?: string } = {},
  ): Promise<RoomConfig> {
    return await FileLock.withLock(this.lockPath, async () => {
      const ref = roomRef(roomId);
      const remoteRooms = await this.repo.lsRemoteRooms(this.config.remote);
      if (remoteRooms.has(roomId)) {
        throw new Error(
          `room ${roomId} already exists — join it instead: komnet room join ${roomId}`,
        );
      }

      const worktree = this.layout.roomWorktree(this.id, roomId);
      await this.repo.addOrphanWorktree(worktree, ref);
      await this.repo.runner.run(
        ["commit", "--quiet", "--allow-empty", "-m", `komnet: open room ${roomId}`],
        { cwd: worktree },
      );
      await this.repo.pushNewBranch(worktree, ref, REMOTE);

      const room = createRoomConfig({ ...options, id: roomId, createdBy: this.identity.id });
      await this.repo.commitFile(
        this.recordWorktree,
        roomConfigPath(roomId),
        serializeRoomConfig(room),
        `komnet: create room ${roomId}`,
      );
      await this.repo.pushWithRetry(this.recordWorktree, MAIN_REF, { remote: REMOTE });

      this.subscribe(roomId);
      await this.repo.setFetchScope(REMOTE, this.config.subscriptions);
      return room;
    });
  }

  async joinRoom(roomId: string): Promise<void> {
    await FileLock.withLock(this.lockPath, async () => {
      this.subscribe(roomId);
      await this.repo.setFetchScope(REMOTE, this.config.subscriptions);
      await this.ensureRoomWorktree(roomId);
    });
  }

  async leaveRoom(roomId: string): Promise<void> {
    await FileLock.withLock(this.lockPath, async () => {
      this.config.subscriptions = this.config.subscriptions.filter((r) => r !== roomId);
      const worktree = this.layout.roomWorktree(this.id, roomId);
      if (await exists(worktree)) await this.repo.removeWorktree(worktree, true);
      this.state.forgetRoom(roomId);
      await this.repo.setFetchScope(REMOTE, this.config.subscriptions);
    });
  }

  private subscribe(roomId: string): void {
    if (!this.config.subscriptions.includes(roomId)) this.config.subscriptions.push(roomId);
    this.config.subscriptions.sort();
  }

  /**
   * Materialise a room's worktree, fetching the branch if this clone has not
   * seen it yet.
   */
  private async ensureRoomWorktree(roomId: string): Promise<string> {
    const worktree = this.layout.roomWorktree(this.id, roomId);
    if (await exists(worktree)) return worktree;

    const ref = roomRef(roomId);
    await mkdir(this.layout.networkDir(this.id), { recursive: true });

    if (await this.repo.refExists(ref)) {
      await this.repo.addWorktree(worktree, ref);
      return worktree;
    }

    await this.repo.fetch(this.config.remote, [`+refs/heads/${ref}:refs/remotes/${REMOTE}/${ref}`]);
    if (await this.repo.refExists(`refs/remotes/${REMOTE}/${ref}`)) {
      await this.repo.addWorktree(worktree, ref, { createFrom: `refs/remotes/${REMOTE}/${ref}` });
      return worktree;
    }
    throw new Error(
      `room ${roomId} does not exist on the remote — create it: komnet room create ${roomId}`,
    );
  }

  async readRoomConfig(roomId: string): Promise<RoomConfig | null> {
    const path = join(this.recordWorktree, roomConfigPath(roomId));
    if (!(await exists(path))) return null;
    return parseRoomConfig(await readFile(path, "utf8"));
  }

  // ------------------------------------------------------------------ sending

  async send(
    roomId: string,
    input: SendInput,
    extraRules: readonly SecretRule[] = [],
  ): Promise<Message> {
    return await FileLock.withLock(this.lockPath, async () => {
      const worktree = await this.ensureRoomWorktree(roomId);

      // Blocking, never advisory: git history is permanent, so a leaked
      // credential cannot be recalled (docs/design/08-security-and-trust.md §3).
      const findings = scanForSecrets(input.body, { extraRules });
      if (findings.length > 0 && input.forceUnsafe === undefined) {
        throw new SecretDetectedError(findings);
      }

      const head = await this.repo.resolveRef(`refs/heads/${roomRef(roomId)}`);
      const id = ulid();

      // A reply joins its parent's thread. Without this every answer would open
      // a new thread, and `threadOrder` would render conversations as a flat
      // list of unrelated roots.
      let thread = input.thread;
      if (thread === undefined && input.inReplyTo !== undefined) {
        const existing = await new RoomStore(worktree, roomId).readAll(() => undefined);
        const parent = existing.find((m) => m.header.id === input.inReplyTo);
        thread = parent?.header.thread ?? input.inReplyTo;
      }

      const message = createMessage({
        id,
        room: roomId,
        from: this.identity.id,
        authorKind: input.authorKind ?? "agent",
        kind: input.kind ?? "msg",
        needs: input.needs ?? "none",
        body: input.body.endsWith("\n") ? input.body : `${input.body}\n`,
        ...(thread === undefined ? {} : { thread }),
        ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
        ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        ...(head === null ? {} : { seen: head }),
      });
      if (input.forceUnsafe !== undefined) {
        message.header.unsafeReason = input.forceUnsafe;
      }

      const store = new RoomStore(worktree, roomId);
      const repoPath = await store.writeMessage(message);
      await this.repo.runner.run(["add", "--", repoPath], { cwd: worktree });
      await this.repo.runner.run(["commit", "--quiet", "-F", "-"], {
        cwd: worktree,
        input: `komnet: ${message.header.kind} in ${roomId}\n\n${message.header.id}\n`,
      });
      await this.repo.pushWithRetry(worktree, roomRef(roomId), { remote: REMOTE });

      const newHead = await this.repo.runner.text(["rev-parse", "HEAD"], { cwd: worktree });
      this.state.setHead(roomId, newHead);
      return message;
    });
  }

  /**
   * Answer a message.
   *
   * A `needs: human` question may only be answered by a human (spec §4.3) —
   * this is the protocol's core human-in-the-loop guarantee, so it is enforced
   * here rather than left to the caller's good behaviour.
   */
  async answer(messageId: string, body: string, asHuman: boolean): Promise<Message> {
    const item = this.state.listInbox({ includeProcessed: true }).find((i) => i.id === messageId);
    if (item === undefined) throw new Error(`no message ${messageId} in this agent's inbox`);

    if (item.needs === "human" && !asHuman) {
      throw new Error(
        `message ${messageId} is marked 'needs: human'. An agent must not answer on its human's behalf. ` +
          `Surface it to a person, then record their decision with --as-human.`,
      );
    }

    const sent = await this.send(item.room, {
      body,
      kind: "answer",
      needs: "none",
      inReplyTo: item.id,
      // Taken from the inbox row rather than re-read from the room: the parent
      // may already have been pruned out of the live window by a seal.
      thread: item.thread,
      mentions: [item.from],
      authorKind: asHuman ? "human" : "agent",
    });
    this.state.resolveHumanItem(item.id);
    return sent;
  }

  // ------------------------------------------------------------------ reading

  async read(
    roomId: string,
    options: { limit?: number; thread?: string } = {},
  ): Promise<Message[]> {
    const worktree = await this.ensureRoomWorktree(roomId);
    const store = new RoomStore(worktree, roomId);
    let messages = await store.readAll(() => undefined);
    if (options.thread !== undefined) {
      messages = messages.filter((m) => m.header.thread === options.thread);
    }
    messages = threadOrder(messages);
    if (options.limit !== undefined && messages.length > options.limit) {
      messages = messages.slice(-options.limit);
    }
    return messages;
  }

  /**
   * Read past the live window, via git history.
   *
   * Sealing removes old messages from the tree but never from history, so this
   * is what makes "pruning is not data loss" true in practice rather than only
   * in principle (docs/design/06-retention-and-sealing.md §1).
   */
  async history(
    roomId: string,
    options: { since?: string; limit?: number } = {},
  ): Promise<Message[]> {
    await this.ensureRoomWorktree(roomId);
    const ref = `refs/heads/${roomRef(roomId)}`;
    const entries = await this.repo.logAddedPaths(
      ref,
      `rooms/${roomId}/msg/`,
      options.since === undefined ? {} : { since: options.since },
    );

    const messages: Message[] = [];
    const seen = new Set<string>();
    for (const { commit, path } of entries) {
      if (!isMessagePath(path) || seen.has(path)) continue;
      seen.add(path);
      const raw = await this.repo.readFile(commit, path);
      if (raw === null) continue;
      try {
        messages.push(parseMessage(raw, path));
      } catch {
        // One unreadable historical message must not sink the whole query.
      }
    }
    const ordered = threadOrder(messages);
    return options.limit === undefined ? ordered : ordered.slice(-options.limit);
  }

  /**
   * Substring search across the live window of subscribed rooms.
   *
   * Deliberately scoped to the tree, not history: an all-time search means
   * fetching every blob, which under a partial clone is exactly the expensive
   * operation the design avoids. `history` is the explicit way to go deeper.
   */
  async search(
    query: string,
    options: { room?: string; limit?: number } = {},
  ): Promise<{ room: string; message: Message }[]> {
    const needle = query.toLowerCase();
    const rooms = options.room === undefined ? this.config.subscriptions : [options.room];
    const hits: { room: string; message: Message }[] = [];

    for (const roomId of rooms) {
      const worktree = this.layout.roomWorktree(this.id, roomId);
      if (!(await exists(worktree))) continue;
      const messages = await new RoomStore(worktree, roomId).readAll(() => undefined);
      for (const message of messages) {
        if (message.body.toLowerCase().includes(needle)) hits.push({ room: roomId, message });
      }
    }
    hits.sort((a, b) => (a.message.header.id < b.message.header.id ? 1 : -1));
    return options.limit === undefined ? hits : hits.slice(0, options.limit);
  }

  inbox(query: InboxQuery = {}): InboxItem[] {
    return this.state.listInbox(query);
  }

  /**
   * Mark items processed. `needs: human` items are refused — only a human
   * answer clears those.
   */
  drainInbox(ids: readonly string[]): { drained: number; refused: string[] } {
    const items = this.state.listInbox({ includeProcessed: true });
    const byId = new Map(items.map((i) => [i.id, i]));
    const refused = ids.filter((id) => byId.get(id)?.needs === "human");
    const drained = this.state.markProcessed(ids.filter((id) => !refused.includes(id)));
    return { drained, refused };
  }

  // --------------------------------------------------------------------- sync

  async sync(): Promise<SyncReport> {
    return await FileLock.withLock(this.lockPath, async () => {
      const subscribed = new Set(this.config.subscriptions);
      const remoteHeads = await this.repo.lsRemoteRooms(this.config.remote);
      const diff = diffRoomHeads(this.state.allHeads(), remoteHeads, subscribed);

      const report: SyncReport = {
        roomsPolled: remoteHeads.size,
        changed: diff.changed,
        recorded: 0,
        delivered: 0,
        anomalies: [],
        unreadable: [],
      };

      for (const change of diff.changed) {
        const ref = roomRef(change.roomId);
        await this.repo.fetch(this.config.remote, [
          `+refs/heads/${ref}:refs/remotes/${REMOTE}/${ref}`,
        ]);
        const worktree = await this.ensureRoomWorktree(change.roomId);
        await this.repo.fastForward(worktree, `refs/remotes/${REMOTE}/${ref}`);

        const update = await collectRoomUpdate(this.repo, change);
        report.recorded += update.messages.length;
        report.anomalies.push(...update.anomalies);
        report.unreadable.push(...update.unreadable);

        for (const message of update.messages) {
          if (this.shouldDeliver(message, subscribed)) {
            this.state.addToInbox(message, messagePath(message.header));
            report.delivered += 1;
          }
        }
        this.state.setHead(change.roomId, change.to);
      }

      // Keep `main` current too, so room configs and agent cards stay fresh.
      await this.repo
        .fetch(this.config.remote, [`+refs/heads/main:refs/remotes/${REMOTE}/main`])
        .then(() => this.repo.fastForward(this.recordWorktree, `refs/remotes/${REMOTE}/main`))
        .catch(() => undefined);

      this.state.setMeta("lastSyncAt", new Date().toISOString());
      return report;
    });
  }

  /**
   * Routing (docs/design/05-delivery-and-humans.md §2).
   *
   * Everything is recorded in the room regardless; this decides only what lands
   * in the inbox and can raise a notification. Conflating the two makes a
   * system either noisy or lossy.
   */
  private shouldDeliver(message: Message, subscribed: ReadonlySet<string>): boolean {
    if (message.header.from === this.identity.id) return false;
    if (isAddressedTo(message.header, this.identity.id, subscribed)) return true;
    // A decision only a person can make reaches that person even without a mention.
    return message.header.needs === "human";
  }

  async status(): Promise<NetworkStatus> {
    return {
      networkId: this.id,
      remote: this.config.remote,
      agentId: this.identity.id,
      subscriptions: [...this.config.subscriptions],
      pending: this.state.pendingCount(),
      pendingHuman: this.state.listInbox({ needs: "human" }).length,
      lastSyncAt: this.state.getMeta("lastSyncAt"),
      heads: Object.fromEntries(this.state.allHeads()),
    };
  }

  /** Render pending items as plain markdown, for agents with no integration. */
  async writeInboxFiles(): Promise<number> {
    const dir = this.layout.agentInboxDir(this.identity.id);
    await mkdir(dir, { recursive: true });
    const items = this.state.listInbox({});
    for (const item of items) {
      const file = join(dir, `${item.room}--${item.id}.md`);
      if (await exists(file)) continue;
      await writeFile(
        file,
        `# ${item.room} · ${item.from}\n\n` +
          `- id: ${item.id}\n- kind: ${item.kind}\n- needs: ${item.needs}\n` +
          `- priority: ${item.priority}\n- sent: ${item.ts}\n\n---\n\n${item.body}\n`,
        "utf8",
      );
    }
    return items.length;
  }

  close(): void {
    this.state.close();
  }
}

/** Compare cards ignoring the presence block, which changes on every write. */
function stripPresence(yaml: string): string {
  return yaml.replace(/presence:[\s\S]*$/, "").trim();
}
