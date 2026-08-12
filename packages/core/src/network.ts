import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  HANDSHAKE_ACK_TAG,
  HANDSHAKE_TAG,
  MAIN_REF,
  MENTION_ROOM,
  assertReviewTransition,
  agentCardPath,
  createMessage,
  createReviewTask,
  isMessagePath,
  messagePath,
  parseMessage,
  receiptPath,
  roomConfigPath,
  roomDir,
  roomRef,
  threadOrder,
  ulid,
  type AuthorKind,
  type Message,
  type MessageKind,
  type Needs,
  type Priority,
  type ReviewTask,
  type ReviewTaskState,
} from "@komnet/protocol";

import {
  cardFromIdentity,
  observedPresenceStatus,
  reconcileSessions,
  parseAgentCard,
  serializeAgentCard,
  type AgentCard,
  type PresenceStatus,
} from "./agent/card.ts";
import { parseReadReceipt, serializeReadReceipt, type ReadReceipt } from "./agent/receipt.ts";
import type { AgentIdentity, NetworkConfig } from "./config.ts";
import { PushExhaustedError, SecretDetectedError } from "./errors.ts";
import { GitRunner } from "./git/runner.ts";
import { Repo } from "./git/repo.ts";
import { Layout } from "./layout.ts";
import { FileLock } from "./lock.ts";
import {
  createRoomConfig,
  DEFAULT_ROOM_POLICY,
  parseRoomConfig,
  serializeRoomConfig,
  type RoomConfig,
} from "./room/config.ts";
import {
  assessReviewDiscussionPressure,
  assessThreadPressure,
  pressureNeeds,
} from "./room/pressure.ts";
import { reduceReviewTasks, type ReviewTaskStatus } from "./review/tasks.ts";
import { RoomStore } from "./room/store.ts";
import { scanForSecrets, type SecretRule } from "./scanner/secrets.ts";
import { verifyMessage, signMessage, type Verification } from "./authenticity.ts";
import { parseNetManifest, type AuthenticityMode, type NetManifest } from "./net.ts";
import {
  DEFAULT_SEAL_POLICY,
  Sealer,
  type SealDecision,
  type SealPolicy,
  type SealResult,
} from "./seal/sealer.ts";
import { StateDb, type InboxItem, type InboxQuery } from "./state.ts";
import {
  collectRoomUpdate,
  diffRoomHeads,
  type Anomaly,
  type RoomChange,
} from "./sync/detector.ts";
import { shouldDeliverMessage } from "./sync/routing.ts";

const REMOTE = "origin";

export interface SendInput {
  body: string;
  kind?: MessageKind;
  needs?: Needs;
  mentions?: string[];
  priority?: Priority;
  tags?: string[];
  refs?: string[];
  review?: ReviewTask;
  inReplyTo?: string;
  thread?: string;
  authorKind?: AuthorKind;
  /** Override a secret-scanner block. Recorded permanently in the header. */
  forceUnsafe?: string;
}

export interface ReviewRequestInput {
  reviewer: string;
  repo: string;
  baseRev: string;
  headRev: string;
  summary: string;
  scope?: string[];
  deadline?: string;
}

export interface ReviewUpdateInput {
  state: ReviewTaskState;
  body: string;
  refs?: string[];
}

export interface HandshakeInput {
  /** Room to greet in. Required unless `ackTo` is given, which implies one. */
  room?: string;
  /** Agents to address. Defaults to `@room` — everyone subscribed. */
  peers?: string[];
  /** A line of context appended to the greeting. */
  note?: string;
  /** Answer this handshake rather than opening one. */
  ackTo?: string;
}

/** Another agent on the network, with presence as observed right now. */
export interface HandshakePeer {
  id: string;
  status: PresenceStatus;
  lastSeen: string;
  tool: string;
  human: string;
}

export interface HandshakeResult {
  room: string;
  /** The thread to watch for the other side's reply. */
  thread: string;
  message: Message;
  role: "open" | "ack";
  /** Who the greeting was addressed to; `['@room']` when unaddressed. */
  addressed: string[];
  peers: HandshakePeer[];
  /**
   * Whether this run actually pushed a presence transition.
   *
   * False means the card already said `live` — the network was told nothing
   * new, which is a success, not a failure.
   */
  presencePublished: boolean;
  /**
   * Whether the pre-greeting sync reached the remote.
   *
   * False means the greeting is queued rather than sent and `peers` was read
   * from a possibly stale local roster. Reported instead of thrown: a handshake
   * opened offline is delayed, not lost.
   */
  synced: boolean;
}

/** A message naming this agent in a room it does not follow. */
export interface DiscoveredMention {
  room: string;
  id: string;
  from: string;
  ts: string;
  needs: string;
  kind: string;
}

export interface WaitForInboxOptions {
  room?: string;
  needs?: string;
  tag?: string;
  thread?: string;
  /** Clamped to [1s, 60s]. See `waitForInbox` for why the ceiling exists. */
  timeoutMs?: number;
  pollMs?: number;
}

export interface WaitForInboxResult {
  items: InboxItem[];
  timedOut: boolean;
  waitedMs: number;
}

/**
 * Ceiling on a blocking wait.
 *
 * Sized for an MCP request rather than for patience: clients enforce their own
 * timeouts, so a longer block is killed by the transport instead of answered.
 */
export const MAX_WAIT_MS = 60_000;
export const MIN_WAIT_MS = 1_000;

/**
 * Clamp a requested wait into the supported band.
 *
 * Separated from the waiting so the ceiling can be asserted without a test that
 * actually sits out a minute — the rule is arithmetic, and only the blocking is
 * slow.
 */
export function clampWaitMs(requested: number | undefined): number {
  return Math.min(Math.max(requested ?? 30_000, MIN_WAIT_MS), MAX_WAIT_MS);
}

export interface SyncReport {
  roomsPolled: number;
  changed: RoomChange[];
  recorded: number;
  delivered: number;
  /**
   * The messages that actually landed in this agent's inbox.
   *
   * Carried on the report so the daemon can decide what deserves a
   * notification without re-querying and diffing the inbox — routing already
   * computed this.
   */
  deliveredMessages: Message[];
  /** Rooms whose queued-while-offline commits were pushed by this sync. */
  drained: { roomId: string; pushed: number }[];
  /**
   * Messages whose author could not be verified under the network's
   * authenticity mode. Delivered anyway, with a warning: silently dropping
   * them would let an attacker suppress traffic (spec §10).
   */
  unverified: { id: string; from: string; room: string; reason: string }[];
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

/**
 * What a relay surface supplies before recording declared human provenance.
 *
 * A callback keeps the ordinary agent path separate from the explicit relay
 * flow. It is a workflow affordance, not authentication (ADR 0012).
 */
export interface HumanConfirmationRequest {
  messageId: string;
  room: string;
  from: string;
  question: string;
  answer: string;
}

export interface AnswerOptions {
  /** Relay confirmation, normally from the interactive CLI. This is not identity proof. */
  confirmHuman?: (request: HumanConfirmationRequest) => Promise<boolean>;
}

export interface NetworkStatus {
  networkId: string;
  remote: string;
  agentId: string;
  subscriptions: string[];
  pending: number;
  pendingHuman: number;
  /** Messages committed locally but not yet accepted by the remote. */
  queued: number;
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

  /**
   * Publish (or refresh) this agent's card on `main`. Own file only.
   *
   * Returns whether anything was actually pushed — presence is published on
   * transition, and the caller uses this to avoid logging a no-op.
   */
  async publishAgentCard(
    extras: {
      expertise?: string[];
      speaksFor?: string[];
      presence?: "live" | "away";
      /** Which attached session is arriving or leaving. See `reconcileSessions`. */
      session?: string;
    } = {},
  ): Promise<boolean> {
    return await FileLock.withLock(this.lockPath, async () => {
      const path = agentCardPath(this.identity.id);
      const absolute = join(this.recordWorktree, path);
      const existing = (await exists(absolute)) ? await readFile(absolute, "utf8") : null;
      let previous: AgentCard | null = null;
      if (existing !== null) {
        try {
          previous = parseAgentCard(existing);
        } catch {
          // Replacing our own malformed card is safer than preserving it.
        }
      }
      const gitAuthor = await this.gitIdentity();
      const card = cardFromIdentity(this.identity, {
        expertise: extras.expertise ?? previous?.expertise ?? [],
        speaksFor: extras.speaksFor ?? previous?.speaksFor ?? [],
        ...(gitAuthor === null
          ? previous?.gitAuthor === undefined
            ? {}
            : { gitAuthor: previous.gitAuthor }
          : { gitAuthor }),
      });
      if (previous?.human.workingHours !== undefined) {
        card.human.workingHours = previous.human.workingHours;
      }
      // Reconcile the attached-session set BEFORE deciding the status: with two
      // concurrent sessions, one leaving must not take the agent away with it.
      if (extras.presence === undefined) {
        card.presence.status = previous?.presence.status ?? "away";
        card.presence.sessions = previous?.presence.sessions ?? [];
      } else {
        const reconciled = reconcileSessions(previous?.presence.sessions ?? [], {
          status: extras.presence,
          ...(extras.session === undefined ? {} : { session: extras.session }),
        });
        card.presence.status = reconciled.status;
        card.presence.sessions = reconciled.sessions;
      }
      const next = serializeAgentCard(card);
      // `last_seen` moves on every call, so comparing it would produce a commit
      // per invocation. Everything else — including presence *status* — is
      // compared, so a genuine online/offline transition does get published.
      if (existing !== null && stripLastSeen(existing) === stripLastSeen(next)) return false;

      await this.repo.commitFile(
        this.recordWorktree,
        path,
        next,
        `komnet: agent ${this.identity.id}`,
      );
      await this.repo.pushWithRetry(this.recordWorktree, MAIN_REF, {
        remote: REMOTE,
        // Presence is advisory and frequently contended at the start of a work
        // day. Keep its inline ladder short; a later transition can converge
        // the already-durable local commit without blocking editor startup.
        ...(extras.presence === undefined
          ? {}
          : { maxAttempts: 3, backoffBaseMs: 100, backoffCapMs: 1_000 }),
      });
      return true;
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
      // Establish the remote-tracking ref immediately: the outbox measures
      // against it, and `push --set-upstream` on a fresh orphan does not create
      // it under our scoped refspec.
      await this.repo
        .fetch(this.config.remote, [`+refs/heads/${ref}:refs/remotes/${REMOTE}/${ref}`])
        .catch(() => undefined);

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
      let existingMessages: Message[] | null = null;
      if (thread === undefined && input.inReplyTo !== undefined) {
        existingMessages = await new RoomStore(worktree, roomId).readAll(() => undefined);
        const parent = existingMessages.find((m) => m.header.id === input.inReplyTo);
        thread = parent?.header.thread ?? input.inReplyTo;
      }

      const authorKind = input.authorKind ?? "agent";
      const pressureEligible = input.review === undefined || input.review.state === "discussing";
      const pressure =
        authorKind === "agent" && thread !== undefined && pressureEligible
          ? input.review?.state === "discussing"
            ? assessReviewDiscussionPressure(
                existingMessages ??
                  (await new RoomStore(worktree, roomId).readAll(() => undefined)),
                thread,
                input.review.id,
                (await this.readRoomConfig(roomId))?.policy.replyBudget ??
                  DEFAULT_ROOM_POLICY.replyBudget,
              )
            : assessThreadPressure(
                existingMessages ??
                  (await new RoomStore(worktree, roomId).readAll(() => undefined)),
                thread,
                (await this.readRoomConfig(roomId))?.policy.replyBudget ??
                  DEFAULT_ROOM_POLICY.replyBudget,
              )
          : null;
      const needs = pressureNeeds(input.needs, pressure);
      const tags = [...(input.tags ?? [])];
      const review =
        pressure?.shouldPark === true && input.review?.state === "discussing"
          ? { ...input.review, state: "needs_human" as const }
          : input.review;
      if (pressure?.shouldPark === true && !tags.includes("reply-budget")) {
        tags.push("reply-budget");
      }

      const message = createMessage({
        id,
        room: roomId,
        from: this.identity.id,
        authorKind,
        kind: input.kind ?? "msg",
        needs,
        body: input.body.endsWith("\n") ? input.body : `${input.body}\n`,
        ...(thread === undefined ? {} : { thread }),
        ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
        ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(tags.length === 0 ? {} : { tags }),
        ...(input.refs === undefined ? {} : { refs: input.refs }),
        ...(review === undefined ? {} : { review }),
        ...(head === null ? {} : { seen: head }),
      });
      if (input.forceUnsafe !== undefined) {
        message.header.unsafeReason = input.forceUnsafe;
      }

      // Sign BEFORE writing: the canonical form excludes `sig`, so signing a
      // message already on disk would still produce the same bytes — but doing
      // it here keeps the file written exactly once.
      if ((await this.authenticityMode()) === "signed") {
        const keyPath = await this.signingKeyPath();
        if (keyPath === null) {
          throw new Error(
            "this network requires signed messages, but no SSH signing key was found. " +
              "Set one with: git config user.signingkey ~/.ssh/id_ed25519.pub",
          );
        }
        const signature = await signMessage(message, keyPath);
        if (signature === null) {
          throw new Error(`could not sign the message with ${keyPath}`);
        }
        message.header.sig = signature.trim();
      }

      const store = new RoomStore(worktree, roomId);
      const repoPath = await store.writeMessage(message);
      await this.repo.runner.run(["add", "--", repoPath], { cwd: worktree });
      await this.repo.runner.run(["commit", "--quiet", "-F", "-"], {
        cwd: worktree,
        input: `komnet: ${message.header.kind} in ${roomId}\n\n${message.header.id}\n`,
      });
      try {
        // A SHORT ladder on purpose. Inline retries are for push contention,
        // which clears in milliseconds; an actual outage is the outbox's job.
        // Walking the full ladder here would make a user wait a minute before
        // their offline message was even queued.
        await this.repo.pushWithRetry(worktree, roomRef(roomId), {
          remote: REMOTE,
          maxAttempts: 3,
          backoffBaseMs: 100,
          backoffCapMs: 1_000,
        });
      } catch (error) {
        // The commit is already durable, so an unreachable remote is not a lost
        // message — it is a queued one. Only a genuinely stuck push lands here;
        // auth failures still surface, because those need a human.
        if (!(error instanceof PushExhaustedError)) throw error;
        this.state.setMeta(`queuedSince:${roomId}`, new Date().toISOString());
      }

      const newHead = await this.repo.runner.text(["rev-parse", "HEAD"], { cwd: worktree });
      this.state.setHead(roomId, newHead);
      return message;
    });
  }

  /** Create a targeted agent-to-agent repository review task. */
  async requestReview(roomId: string, input: ReviewRequestInput): Promise<Message> {
    const review = createReviewTask({
      id: ulid(),
      requester: this.identity.id,
      reviewer: input.reviewer,
      repo: input.repo,
      baseRev: input.baseRev,
      headRev: input.headRev,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
    });
    return await this.send(roomId, {
      body: input.summary,
      kind: "question",
      needs: "agent",
      mentions: [input.reviewer],
      tags: ["review-task"],
      review,
    });
  }

  /** Current valid state of every review task in a room. */
  async listReviewTasks(roomId: string): Promise<ReviewTaskStatus[]> {
    return reduceReviewTasks(await this.read(roomId));
  }

  /** Append one guarded state transition to an existing review task. */
  async updateReview(roomId: string, reviewId: string, input: ReviewUpdateInput): Promise<Message> {
    const status = (await this.listReviewTasks(roomId)).find(
      (candidate) => candidate.review.id === reviewId,
    );
    if (status === undefined) throw new Error(`no review task ${reviewId} in room ${roomId}`);

    const review: ReviewTask = { ...status.review, state: input.state };
    assertReviewTransition(status.review, review, this.identity.id);

    const mentions = reviewMentions(review, this.identity.id);
    return await this.send(roomId, {
      body: input.body,
      ...(input.refs === undefined ? {} : { refs: input.refs }),
      kind: "status",
      needs: reviewNeeds(review.state),
      ...(mentions.length === 0 ? {} : { mentions }),
      tags: ["review-task", `review-state:${review.state}`],
      inReplyTo: status.currentMessageId,
      thread: status.thread,
      review,
    });
  }

  /**
   * Answer a message.
   *
   * The ordinary agent-facing path refuses `needs: human`; the interactive CLI
   * can relay an answer with `author_kind: human`. That marker is cooperative
   * attribution, not proof of human presence: an agent and its human commonly
   * share the same OS identity and terminal capability (ADR 0012).
   */
  async answer(messageId: string, body: string, options: AnswerOptions = {}): Promise<Message> {
    const item = this.state.listInbox({ includeProcessed: true }).find((i) => i.id === messageId);
    if (item === undefined) throw new Error(`no message ${messageId} in this agent's inbox`);

    let authorKind: AuthorKind = "agent";

    if (item.needs === "human") {
      if (options.confirmHuman === undefined) {
        throw new Error(
          `message ${messageId} is marked 'needs: human', so this direct agent path will not ` +
            `answer it. Surface it to a person, then relay their decision with ` +
            `'komnet answer ${messageId} "<their words>" --as-human'. Human attribution is ` +
            `cooperative, not identity proof.`,
        );
      }
      const confirmed = await options.confirmHuman({
        messageId: item.id,
        room: item.room,
        from: item.from,
        question: item.body,
        answer: body,
      });
      if (!confirmed) throw new Error("not recorded — the human did not confirm this answer");
      authorKind = "human";
    } else if (options.confirmHuman !== undefined) {
      // An ordinary message answered from the interactive path is still the
      // human speaking, and the record should say so.
      authorKind = (await options.confirmHuman({
        messageId: item.id,
        room: item.room,
        from: item.from,
        question: item.body,
        answer: body,
      }))
        ? "human"
        : "agent";
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
      authorKind,
    });
    this.state.resolveHumanItem(item.id);
    return sent;
  }

  // ---------------------------------------------------------------- handshake

  /**
   * Declare this agent live without sending anything.
   *
   * Presence is a transition, not a heartbeat, so this is a no-op commit-wise
   * when the card already says what you are telling it. What "live" asserts is
   * narrow and worth stating: *an agent session announced itself at this
   * timestamp*. Nothing here keeps that true afterwards — the claim decays to
   * `stale` on its own (`PRESENCE_STALE_AFTER_MS`), which is why a reader must
   * use `observedPresenceStatus` rather than trusting the stored bit.
   *
   * Like every presence signal in komnet it is cooperative, not authenticated.
   */
  async announce(status: "live" | "away", options: { session?: string } = {}): Promise<boolean> {
    return await this.publishAgentCard({
      presence: status,
      ...(options.session === undefined ? {} : { session: options.session }),
    });
  }

  /**
   * Open — or answer — a first-contact exchange.
   *
   * The problem this solves is not sending a message; it is that establishing
   * contact took a person driving both machines. Every step below is one a
   * human previously had to remember: say you are here, make sure the room is
   * actually subscribed, pull before you look, greet, then report who is around
   * to answer.
   *
   * Deliberately NOT part of this: waiting. This method returns as soon as the
   * greeting is durable, and the caller watches `thread` for the reply. Waiting
   * inline would either block a session for as long as the peer's human is
   * asleep, or impose a timeout that is wrong for a network spanning
   * timezones (ADR 0006 — nothing here starts the other side).
   *
   * Not wrapped in the repository lock: `joinRoom`, `publishAgentCard`, `sync`
   * and `send` each take it in turn, and the lock is not reentrant.
   */
  async handshake(input: HandshakeInput = {}): Promise<HandshakeResult> {
    const ack = input.ackTo === undefined ? null : this.requireHandshakeParent(input.ackTo);
    const roomId = ack?.room ?? input.room;
    if (roomId === undefined) {
      throw new Error("handshake needs a room, or a handshake message id to answer");
    }

    if (!this.config.subscriptions.includes(roomId)) await this.joinRoom(roomId);

    const presencePublished = await this.announce("live");

    // Best effort: an unreachable remote must not stop the greeting. `send`
    // queues to the outbox when it cannot push, so a handshake opened offline
    // still goes out on reconnect — it just reports a roster that may be stale.
    let synced = true;
    try {
      await this.sync();
    } catch {
      synced = false;
    }

    const addressed = ack !== null ? [ack.from] : (input.peers ?? [MENTION_ROOM]);
    const message = await this.send(roomId, {
      body: this.handshakeBody(ack, input.note),
      kind: ack !== null ? "answer" : "question",
      // An opening asks the other agent for one thing it can answer by itself.
      // `needs: human` would park first contact on a person, which is the
      // manual step this exists to remove.
      needs: ack !== null ? "none" : "agent",
      mentions: addressed,
      tags: [ack !== null ? HANDSHAKE_ACK_TAG : HANDSHAKE_TAG],
      ...(ack === null ? {} : { inReplyTo: ack.id, thread: ack.thread }),
    });

    if (ack !== null) this.state.markProcessed([ack.id]);

    const self = this.identity.id;
    const peers: HandshakePeer[] = (await this.listAgents())
      .filter((card) => card.id !== self)
      .map((card) => ({
        id: card.id,
        status: observedPresenceStatus(card.presence),
        lastSeen: card.presence.lastSeen,
        tool: card.tool,
        human: card.human.name,
      }));

    return {
      room: roomId,
      thread: message.header.thread,
      message,
      role: ack !== null ? "ack" : "open",
      addressed,
      peers,
      presencePublished,
      synced,
    };
  }

  /**
   * Resolve the message an ack answers, refusing anything that is not an open
   * handshake addressed to this agent.
   *
   * Both refusals are load-bearing. Acking a `needs: human` item would let an
   * automated reply stand in for a person's decision, which is exactly what
   * ADR 0012 forbids — and it would do it silently, because an ack is sent
   * without anyone reading the question. Requiring the opening tag is what
   * stops the exchange looping: an ack is itself tagged, so an agent that
   * auto-acked anything would answer the answer, forever.
   */
  private requireHandshakeParent(messageId: string): InboxItem {
    const item = this.state
      .listInbox({ includeProcessed: true })
      .find((candidate) => candidate.id === messageId);
    if (item === undefined) throw new Error(`no message ${messageId} in this agent's inbox`);

    if (item.needs === "human") {
      throw new Error(
        `message ${messageId} is marked 'needs: human' and will not be answered by a handshake. ` +
          `Surface it to a person and relay their words with ` +
          `'komnet answer ${messageId} "<their words>" --as-human'.`,
      );
    }
    if (!item.tags.includes(HANDSHAKE_TAG)) {
      throw new Error(
        `message ${messageId} is not an open handshake (tags: ${
          item.tags.length === 0 ? "none" : item.tags.join(", ")
        }). Reply to it with 'komnet answer ${messageId} "<your reply>"' instead.`,
      );
    }
    return item;
  }

  private handshakeBody(ack: InboxItem | null, note: string | undefined): string {
    const who =
      `${this.identity.id} · ${this.identity.tool} · ` +
      `${this.identity.human.name} · ${this.identity.human.timezone}`;
    const lead =
      ack === null
        ? `handshake — ${who}\n\nFirst contact: checking that messages reach this network and come back.`
        : `handshake ack — ${who}\n\nHeard ${ack.from} in #${ack.room}. This link works in both directions.`;
    return note === undefined || note.trim() === "" ? lead : `${lead}\n\n${note.trim()}`;
  }

  // ------------------------------------------------------------------ receipts

  /**
   * Publish what this agent has read of a room.
   *
   * Called after draining, because that is the moment "I have handled this"
   * becomes true. It writes only this agent's own receipt file, the one thing
   * besides its card that `mayModify` lets an agent rewrite.
   *
   * Returns false when nothing moved: a receipt that re-published an unchanged
   * high-water mark would put a commit on `main` every time an agent looked at
   * an empty inbox.
   */
  async publishReceipt(roomId: string): Promise<boolean> {
    const processed = this.state
      .listInbox({ room: roomId, includeProcessed: true })
      .filter((item) => item.processedAt !== null);
    const readThrough = processed.reduce<string | null>(
      (highest, item) => (highest === null || item.id > highest ? item.id : highest),
      null,
    );
    if (readThrough === null) return false;

    return await FileLock.withLock(this.lockPath, async () => {
      const path = receiptPath(roomId, this.identity.id);
      const absolute = join(this.recordWorktree, path);
      if (await exists(absolute)) {
        try {
          const previous = parseReadReceipt(await readFile(absolute, "utf8"));
          if (previous.readThrough === readThrough && previous.count === processed.length) {
            return false;
          }
        } catch {
          // Replacing our own malformed receipt is safer than preserving it.
        }
      }

      await this.repo.commitFile(
        this.recordWorktree,
        path,
        serializeReadReceipt({
          v: 1,
          agent: this.identity.id,
          room: roomId,
          readThrough,
          count: processed.length,
          updatedAt: new Date().toISOString(),
        }),
        `komnet: receipt ${this.identity.id} ${roomId}`,
      );
      await this.repo.pushWithRetry(this.recordWorktree, MAIN_REF, {
        remote: REMOTE,
        maxAttempts: 3,
        backoffBaseMs: 100,
        backoffCapMs: 1_000,
      });
      return true;
    });
  }

  /** Every agent's read position in one room, newest first. */
  async readReceipts(roomId: string): Promise<ReadReceipt[]> {
    const dir = join(this.recordWorktree, roomDir(roomId), "receipts");
    if (!(await exists(dir))) return [];
    const { readdir } = await import("node:fs/promises");
    const receipts: ReadReceipt[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        receipts.push(parseReadReceipt(await readFile(join(dir, entry.name), "utf8")));
      } catch {
        // One malformed receipt must not make the rest unreadable.
      }
    }
    return receipts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // ---------------------------------------------------------------- discovery

  /**
   * Find messages addressed to this agent in rooms it does NOT follow.
   *
   * Routing only delivers within subscribed rooms, and the fetch scope is the
   * subscription list — so a message that mentions this agent by name in a room
   * it never joined is invisible. Nothing reports it, which makes "addressed to
   * you" quietly weaker than it sounds.
   *
   * Deliberately separate from `sync` and NOT added to the inbox. Sync's whole
   * economy is that one `ls-remote` says which subscribed rooms moved and
   * nothing else is fetched (ADR 0008); folding discovery in would fetch every
   * room on the network on every poll. This is the explicit, occasional
   * question instead, and it answers with "join this room", not by silently
   * widening what the inbox means.
   */
  async discoverMentions(options: { limitPerRoom?: number } = {}): Promise<DiscoveredMention[]> {
    const limit = options.limitPerRoom ?? 25;
    const subscribed = new Set(this.config.subscriptions);
    const remote = await this.repo.lsRemoteHeads(this.config.remote);
    const found: DiscoveredMention[] = [];

    for (const [roomId, head] of remote.rooms) {
      if (subscribed.has(roomId)) continue;
      const ref = `refs/remotes/${REMOTE}/${roomRef(roomId)}`;
      try {
        await this.repo.fetch(this.config.remote, [`+refs/heads/${roomRef(roomId)}:${ref}`]);
      } catch {
        continue; // A room we cannot read is not a room we can report on.
      }

      // Message paths are timestamp-prefixed, so the newest are the last after
      // a plain sort — reading only the tail bounds the cost of looking.
      const paths = (await this.repo.addedSince(null, head, `rooms/${roomId}/`))
        .filter(isMessagePath)
        .sort()
        .slice(-limit);

      for (const path of paths) {
        const raw = await this.repo.readFile(head, path);
        if (raw === null) continue;
        try {
          const message = parseMessage(raw, path);
          if (message.header.from === this.identity.id) continue;
          // Only a DIRECT mention: `@room` addresses subscribers, and this
          // agent is by definition not one of them here.
          if (!message.header.mentions.includes(this.identity.id)) continue;
          found.push({
            room: roomId,
            id: message.header.id,
            from: message.header.from,
            ts: message.header.ts,
            needs: message.header.needs,
            kind: message.header.kind,
          });
        } catch {
          // Unreadable message: not something to report as a mention.
        }
      }
    }
    return found.sort((a, b) => b.id.localeCompare(a.id));
  }

  // ------------------------------------------------------------------- waiting

  /**
   * Block until something matching lands in the inbox, or the bound expires.
   *
   * An agent turn cannot spin, so without this the only options were to poll
   * across turns or hand back to a human. The timeout is CAPPED rather than
   * honoured verbatim: callers reach this over MCP, whose clients enforce their
   * own request timeouts, so a tool that blocks for an hour gets killed by the
   * transport rather than answered. A bounded wait that says "nothing yet, ask
   * again" is honest; an unbounded one is a worse lie than polling.
   */
  async waitForInbox(options: WaitForInboxOptions = {}): Promise<WaitForInboxResult> {
    const timeoutMs = clampWaitMs(options.timeoutMs);
    const pollMs = Math.min(Math.max(options.pollMs ?? 3_000, 500), timeoutMs);
    const deadline = Date.now() + timeoutMs;
    const query: InboxQuery = {
      ...(options.room === undefined ? {} : { room: options.room }),
      ...(options.needs === undefined ? {} : { needs: options.needs }),
      ...(options.tag === undefined ? {} : { tag: options.tag }),
    };
    const matches = (): InboxItem[] => {
      const items = this.inbox(query);
      return options.thread === undefined
        ? items
        : items.filter((item) => item.thread === options.thread);
    };

    for (;;) {
      const found = matches();
      if (found.length > 0) return { items: found, timedOut: false, waitedMs: 0 };
      if (Date.now() >= deadline) return { items: [], timedOut: true, waitedMs: timeoutMs };

      try {
        await this.sync();
      } catch {
        // A transient sync failure must not end the wait early; the deadline does.
      }
      const after = matches();
      if (after.length > 0) {
        return { items: after, timedOut: false, waitedMs: timeoutMs - (deadline - Date.now()) };
      }
      if (Date.now() >= deadline) return { items: [], timedOut: true, waitedMs: timeoutMs };
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
    }
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

  // ------------------------------------------------------------------ sealing

  private sealer(): Sealer {
    return new Sealer({
      repo: this.repo,
      layout: this.layout,
      networkId: this.id,
      agentId: this.identity.id,
      remote: this.config.remote,
    });
  }

  /**
   * The git identity this machine commits with.
   *
   * Published on the agent card so `authenticity: git` has something to check
   * `from` against — otherwise the mode can only ever report "no binding".
   */
  async gitIdentity(): Promise<{ name: string; email: string } | null> {
    // `git var GIT_AUTHOR_IDENT`, not `git config user.email`: the environment
    // (GIT_AUTHOR_EMAIL) overrides config when git actually authors a commit.
    // Recording the config value would publish one identity while committing
    // under another, and every legitimate message would fail verification.
    const ident = await this.repo.runner.tryText(["var", "GIT_AUTHOR_IDENT"], {
      cwd: this.recordWorktree,
    });
    if (ident === null) return null;
    const match = /^(.*?)\s*<([^>]+)>/.exec(ident);
    if (match === null) return null;
    return { name: match[1] ?? "", email: match[2] ?? "" };
  }

  /** SSH key used for `authenticity: signed`, or null when none is configured. */
  private async signingKeyPath(): Promise<string | null> {
    const configured = await this.repo.runner.tryText(["config", "user.signingkey"], {
      cwd: this.recordWorktree,
    });
    if (configured !== null && configured !== "" && (await exists(configured))) return configured;
    const { homedir } = await import("node:os");
    for (const name of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
      const candidate = join(homedir(), ".ssh", name);
      if (await exists(candidate)) return candidate;
    }
    return null;
  }

  /** The network manifest from `main`, which carries the authenticity mode. */
  async readManifest(): Promise<NetManifest | null> {
    const path = join(this.recordWorktree, ".komnet/net.yaml");
    if (!(await exists(path))) return null;
    try {
      return parseNetManifest(await readFile(path, "utf8"));
    } catch {
      return null;
    }
  }

  async authenticityMode(): Promise<AuthenticityMode> {
    // Absent or unreadable manifest → the documented default, not "none".
    return (await this.readManifest())?.authenticity ?? "git";
  }

  /** Retention policy for a room, from its config, falling back to the default. */
  private async sealPolicy(roomId: string): Promise<SealPolicy> {
    const room = await this.readRoomConfig(roomId);
    if (room === null) return DEFAULT_SEAL_POLICY;
    return {
      ...DEFAULT_SEAL_POLICY,
      windowDays: room.retention.windowDays,
      windowMessages: room.retention.windowMessages,
      minIntervalHours: room.retention.sealMinIntervalHours,
    };
  }

  /** What sealing this room would do, without touching anything. */
  async sealDecision(roomId: string): Promise<SealDecision> {
    return await this.sealer().decide(roomId, await this.sealPolicy(roomId));
  }

  /**
   * Compact a room: merge its live branch into `main`, write a digest, promote
   * decisions, then prune the sealed messages out of both trees.
   */
  async seal(roomId: string): Promise<SealResult> {
    const policy = await this.sealPolicy(roomId);
    return await FileLock.withLock(
      this.lockPath,
      async () => {
        const result = await this.sealer().seal(roomId, policy);
        if (result.sealed > 0) {
          // The room worktree just lost files; the local cursor must not claim
          // to have processed a head that no longer exists.
          const head = await this.repo.resolveRef(`refs/heads/${roomRef(roomId)}`);
          if (head !== null) this.state.setHead(roomId, head);
          this.state.setMeta(`lastSealAt:${roomId}`, new Date().toISOString());
        }
        return result;
      },
      // Sealing pushes several times; the default lock timeout is too short.
      { timeoutMs: 10 * 60_000 },
    );
  }

  /** Rooms whose live window has outgrown their retention policy. */
  async roomsNeedingSeal(): Promise<SealDecision[]> {
    const due: SealDecision[] = [];
    for (const roomId of this.config.subscriptions) {
      const policy = await this.sealPolicy(roomId);
      const pending = await this.sealer().hasPendingTransaction(roomId);
      const last = this.state.getMeta(`lastSealAt:${roomId}`);
      if (
        !pending &&
        last !== null &&
        Date.now() - Date.parse(last) < policy.minIntervalHours * 3_600_000
      ) {
        continue;
      }

      const decision = await this.sealer().decide(roomId, policy);
      if (decision.shouldSeal) due.push(decision);
    }
    return due;
  }

  inbox(query: InboxQuery = {}): InboxItem[] {
    return this.state.listInbox(query);
  }

  /**
   * Mark items processed. `needs: human` items are refused — only an answer
   * recorded through the human-relay path clears those.
   */
  drainInbox(ids: readonly string[]): { drained: number; refused: string[] } {
    const items = this.state.listInbox({ includeProcessed: true });
    const byId = new Map(items.map((i) => [i.id, i]));
    const refused = ids.filter((id) => byId.get(id)?.needs === "human");
    const drained = this.state.markProcessed(ids.filter((id) => !refused.includes(id)));
    return { drained, refused };
  }

  // ------------------------------------------------------------------- outbox

  /**
   * Rooms holding local commits the remote has not seen.
   *
   * Derived from git rather than a queue file: a committed message is already
   * durable, so git IS the outbox and cannot drift out of sync with itself.
   */
  async outbox(): Promise<{ roomId: string; ahead: number; since: string | null }[]> {
    const pending: { roomId: string; ahead: number; since: string | null }[] = [];
    for (const roomId of this.config.subscriptions) {
      const worktree = this.layout.roomWorktree(this.id, roomId);
      if (!(await exists(worktree))) continue;
      const ahead = await this.repo.aheadCount(
        worktree,
        `refs/remotes/${REMOTE}/${roomRef(roomId)}`,
      );
      if (ahead > 0) {
        pending.push({ roomId, ahead, since: this.state.getMeta(`queuedSince:${roomId}`) });
      }
    }
    return pending;
  }

  /**
   * Push anything queued while offline. Ordering is preserved automatically —
   * they are consecutive commits on the room branch.
   */
  async drainOutbox(): Promise<{ roomId: string; pushed: number }[]> {
    const drained: { roomId: string; pushed: number }[] = [];
    for (const { roomId, ahead } of await this.outbox()) {
      const worktree = this.layout.roomWorktree(this.id, roomId);
      try {
        await this.repo.pushWithRetry(worktree, roomRef(roomId), { remote: REMOTE });
        // Refresh the remote-tracking ref. `ahead` is measured against it, and
        // an explicit `push <branch>:<branch>` does not reliably move it — so
        // without this the same commits look queued forever and get re-pushed
        // on every sync.
        await this.repo
          .fetch(this.config.remote, [
            `+refs/heads/${roomRef(roomId)}:refs/remotes/${REMOTE}/${roomRef(roomId)}`,
          ])
          .catch(() => undefined);
        this.state.setMeta(`queuedSince:${roomId}`, "");
        drained.push({ roomId, pushed: ahead });
      } catch {
        // Still unreachable. Leave it queued; the next sync tries again.
      }
    }
    return drained;
  }

  /**
   * Agent-card and room-policy commits can also be left local by an outage or
   * a contended `main` push. Keep that record branch convergent just like room
   * outboxes, without pretending an advisory presence write is a message.
   */
  private async drainRecordOutbox(): Promise<void> {
    const trackedMain = `refs/remotes/${REMOTE}/${MAIN_REF}`;
    const ahead = await this.repo.aheadCount(this.recordWorktree, trackedMain);
    if (ahead === 0) return;
    try {
      await this.repo.pushWithRetry(this.recordWorktree, MAIN_REF, {
        remote: REMOTE,
        maxAttempts: 3,
        backoffBaseMs: 100,
        backoffCapMs: 1_000,
      });
      await this.repo.fetch(this.config.remote, [`+refs/heads/${MAIN_REF}:${trackedMain}`]);
    } catch {
      // Still unreachable or contended. The commits remain durable and the
      // next adaptive sync retries; room delivery can continue independently.
    }
  }

  // --------------------------------------------------------------------- sync

  async sync(): Promise<SyncReport> {
    return await FileLock.withLock(this.lockPath, async () => {
      const subscribed = new Set(this.config.subscriptions);
      // Anything queued while offline goes out before we pull, so a reconnect
      // delivers this agent's backlog rather than only fetching everyone else's.
      await this.drainRecordOutbox();
      const drained = await this.drainOutbox();
      const remote = await this.repo.lsRemoteHeads(this.config.remote);
      const diff = diffRoomHeads(this.state.allHeads(), remote.rooms, subscribed);

      const report: SyncReport = {
        roomsPolled: remote.rooms.size,
        changed: diff.changed,
        recorded: 0,
        delivered: 0,
        deliveredMessages: [],
        drained,
        unverified: [],
        anomalies: [],
        unreadable: [],
      };

      // Agent cards and room policy live on main. Refresh it before verifying
      // or routing room messages, but only when its advertised SHA changed.
      // Previously every healthy poll fetched main even when it was identical,
      // doubling remote pressure for a quiet shared room.
      if (remote.main !== null) {
        const trackedMain = `refs/remotes/${REMOTE}/${MAIN_REF}`;
        if ((await this.repo.resolveRef(trackedMain)) !== remote.main) {
          await this.repo
            .fetch(this.config.remote, [`+refs/heads/${MAIN_REF}:${trackedMain}`])
            .catch(() => undefined);
        }
        if ((await this.repo.resolveRef(`refs/heads/${MAIN_REF}`)) !== remote.main) {
          // Fast-forward only when there is no durable local record commit to
          // publish. A divergent local commit belongs to the record outbox and
          // must be rebased/pushed, never discarded.
          const ahead = await this.repo.aheadCount(this.recordWorktree, trackedMain);
          if (ahead === 0) {
            await this.repo.fastForward(this.recordWorktree, trackedMain).catch(() => undefined);
          }
        }
      }

      // A multi-room burst shares the same policy/card snapshot. Reading and
      // parsing the roster once keeps local work proportional to messages, not
      // `changed rooms × registered agents`.
      const mode = diff.changed.length === 0 ? "none" : await this.authenticityMode();
      const cards = mode === "none" ? [] : await this.listAgents();
      const cardById = new Map(cards.map((card) => [card.id, card]));
      const signersPath = join(this.recordWorktree, ".komnet/allowed_signers");
      const haveSigners = mode === "signed" && (await exists(signersPath));

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
          if (mode !== "none") {
            const verification: Verification = await verifyMessage(mode, {
              message,
              commitAuthorEmail: update.commitAuthors.get(message.header.id) ?? null,
              card: cardById.get(message.header.from),
              allowedSignersPath: haveSigners ? signersPath : null,
            });
            if (!verification.verified) {
              report.unverified.push({
                id: message.header.id,
                from: message.header.from,
                room: message.header.room,
                reason: verification.reason ?? "unverified",
              });
            }
          }

          if (this.shouldDeliver(message, subscribed)) {
            this.state.addToInbox(message, messagePath(message.header));
            report.delivered += 1;
            report.deliveredMessages.push(message);
          }
        }
        this.state.setHead(change.roomId, change.to);
      }

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
    return shouldDeliverMessage(message, this.identity.id, subscribed);
  }

  async status(): Promise<NetworkStatus> {
    return {
      networkId: this.id,
      remote: this.config.remote,
      agentId: this.identity.id,
      subscriptions: [...this.config.subscriptions],
      pending: this.state.pendingCount(),
      pendingHuman: this.state.listInbox({ needs: "human" }).length,
      queued: (await this.outbox()).reduce((sum, r) => sum + r.ahead, 0),
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

function reviewNeeds(state: ReviewTaskState): Needs {
  if (state === "needs_human") return "human";
  if (
    state === "requested" ||
    state === "reported" ||
    state === "discussing" ||
    state === "blocked"
  )
    return "agent";
  return "none";
}

function reviewMentions(review: ReviewTask, author: string): string[] {
  switch (review.state) {
    case "requested":
      return [review.reviewer];
    case "discussing":
      return [author === review.requester ? review.reviewer : review.requester];
    case "reported":
    case "blocked":
    case "needs_human":
      return [review.requester];
    case "cancelled":
    case "expired":
      return [review.reviewer];
    case "claimed":
    case "reviewing":
      return [];
    case "completed":
      return [review.reviewer];
  }
}

/** Compare cards ignoring only `last_seen`, which moves on every write. */
function stripLastSeen(yaml: string): string {
  return yaml
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("last_seen:"))
    .join("\n")
    .trim();
}
