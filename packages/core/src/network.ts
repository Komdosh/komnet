import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  HANDSHAKE_ACK_TAG,
  HANDSHAKE_TAG,
  MAIN_REF,
  MENTION_ROOM,
  createMessage,
  isMessagePath,
  isThreadRoot,
  messagePath,
  parseMessage,
  receiptPath,
  roomDir,
  roomRef,
  ulid,
  type AuthorKind,
  type Claim,
  type Message,
  type MessageKind,
  type Needs,
  type Priority,
  type ReviewTask,
  type ReviewTaskState,
  type Task,
  type TaskUpdateAction,
} from "@komnet/protocol";

import type { AgentCard, PresenceStatus } from "./agent/card.ts";
import type {
  AgentDirectoryEntry,
  AgentProfile,
  AgentProfileUpdate,
  AgentRuntimeEnvironment,
} from "./agent/profile.ts";
import { parseReadReceipt, serializeReadReceipt, type ReadReceipt } from "./agent/receipt.ts";
import { ApprovalStore, type ApprovalKind, type ApprovalRecord } from "./approvals.ts";
import { classifyAttention, type Attention } from "./attention.ts";
import type { AgentIdentity, NetworkConfig } from "./config.ts";
import {
  NotSubscribedError,
  ReplyBudgetExceededError,
  SecretDetectedError,
  describeError,
} from "./errors.ts";
import { loadLocalPolicy, type ResolvedPolicy } from "./policy.ts";
import { GitRunner } from "./git/runner.ts";
import { Repo } from "./git/repo.ts";
import { Layout } from "./layout.ts";
import { FileLock } from "./lock.ts";
import { DEFAULT_ROOM_POLICY, type RoomConfig } from "./room/config.ts";
import {
  assessReviewDiscussionPressure,
  assessThreadPressure,
  type ThreadPressure,
} from "./room/pressure.ts";
import type { ReviewTaskStatus } from "./review/tasks.ts";
import type { Agenda, AgendaCounts, AgendaOptions } from "./task/agenda.ts";
import {
  activeTaskThreads,
  type TaskDetail,
  type TaskHealth,
  type TaskStatus,
} from "./task/tasks.ts";
import { type ClaimStatus } from "./room/claims.ts";
import * as claims from "./network/claims.ts";
import type { ClaimsContext } from "./network/claims.ts";
import * as reading from "./network/reading.ts";
import type { ReadingContext } from "./network/reading.ts";
import * as reviews from "./network/reviews.ts";
import * as sealing from "./network/sealing.ts";
import * as rooms from "./network/rooms.ts";
import * as agents from "./network/agents.ts";
import * as tasks from "./network/tasks.ts";
import type { TasksContext } from "./network/tasks.ts";
import * as approvals from "./network/approvals.ts";
import type { ApprovalsContext } from "./network/approvals.ts";
import type { AgentsContext } from "./network/agents.ts";
import type { RoomsContext } from "./network/rooms.ts";
import * as inboxOps from "./network/inbox.ts";
import type { InboxContext } from "./network/inbox.ts";
import * as outboxOps from "./network/outbox.ts";
import type { OutboxContext } from "./network/outbox.ts";
import type { SealingContext } from "./network/sealing.ts";
import * as authenticity from "./network/authenticity.ts";
import type { AuthenticityContext } from "./network/authenticity.ts";
import type { ReviewsContext } from "./network/reviews.ts";
import { exists } from "./fs.ts";
import { RoomStore } from "./room/store.ts";
import { scanForSecrets, type SecretRule } from "./scanner/secrets.ts";
import { verifyMessage, signMessage, type Verification } from "./authenticity.ts";
import type { AuthenticityMode, NetManifest } from "./net.ts";
import type { SealDecision, SealResult } from "./seal/sealer.ts";
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
  task?: Task;
  claim?: Claim;
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

export interface TaskCreateInput {
  title: string;
  definition: string;
  target?: string;
  staleAfterSeconds?: number;
  priority?: Priority;
}

export interface TaskUpdateInput {
  action: TaskUpdateAction | "claimed";
  body: string;
  refs?: string[];
  /** New canonical title; valid only for a refinement. */
  title?: string;
  /** New target; null makes an open task free to claim. Valid only for retargeting. */
  target?: string | null;
  /** Allowed only for blocked/stuck when a genuinely critical human decision is required. */
  needsHuman?: boolean;
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
  /** Newest message this peer wrote in a room we subscribe to, if any. */
  lastActivity: string | null;
  tool: string;
  human: string;
}

/** One row of the roster, with presence corrected by observed activity. */
export interface PresenceRow {
  id: string;
  status: PresenceStatus;
  /** What the agent card declares — a transition, not a heartbeat. */
  lastSeen: string;
  /** What the room log shows. Newer than `lastSeen` is what rescues `stale`. */
  lastActivity: string | null;
  human: string;
  timezone: string;
  tool: string;
  sessions: number;
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
   * Whether this run actually stamped the card.
   *
   * False means the card already read as live — the network was told nothing
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

/** Rooms this agent does not follow, keyed by id → last seen head. */
const SEEN_ROOMS_KEY = "seenRooms";
/** Conversations that started beside this agent, oldest first. */
const STARTED_THREADS_KEY = "startedThreads";
/**
 * How many of those to remember.
 *
 * Small on purpose: this is a hint that a discussion exists, not an archive of
 * one. The room itself is the record, and `komnet read <room>` is one call away.
 */
const MAX_REMEMBERED_THREADS = 50;

function readJsonMeta<T>(state: StateDb, key: string, fallback: T): T {
  const raw = state.getMeta(key);
  if (raw === null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Advisory data written by an older build, or corrupted. Never worth an
    // error on a read path that only adds context.
    return fallback;
  }
}

/** A remembered thread start, with when this machine noticed it. */
export interface StoredThreadStart extends ThreadStart {
  at: string;
}

/** One addressee's position in a message's lifecycle. See `Network.trace`. */
export interface TraceRecipient {
  agent: string;
  /**
   * Whether routing can deliver to them at all: `yes` when their card lists
   * this room, `no` when it does not, `unknown` when they publish no list.
   * A `no` is the reliable direction — nothing else here can be true after it.
   */
  routable: "yes" | "no" | "unknown";
  /** Their read receipt covers this id. An agent processed it, not "understood". */
  read: boolean;
  /** When that receipt was last written. */
  readAt?: string;
  /** They wrote in this thread after this message. The strongest signal there is. */
  answered: boolean;
}

/** Where one message actually got to. See `Network.trace`. */
export interface MessageTrace {
  id: string;
  room: string;
  thread: string;
  from: string;
  needs: string;
  /** Committed locally. Always true for a message this machine can see. */
  stored: boolean;
  /** Present on the remote's copy of the room branch. */
  pushed: boolean;
  recipients: TraceRecipient[];
}

/** The network beside this agent's inbox. See `Network.surroundings`. */
export interface Surroundings {
  /** Rooms on the network this agent has not joined. */
  rooms: string[];
  /** Conversations opened in followed rooms without addressing this agent. */
  threads: StoredThreadStart[];
}

/** A room on the network this agent does not follow. */
export interface RoomDiscovery {
  roomId: string;
  /**
   * `appeared` the first time this machine ever saw the room; `active`
   * afterwards, when its branch moved again.
   *
   * The distinction is what a reader acts on: a room that appeared is a place
   * the team decided to start, and joining it is a decision. A room that is
   * merely active has been there all along.
   */
  state: "appeared" | "active";
}

/** A conversation opened in a followed room, addressed to somebody else. */
export interface ThreadStart {
  room: string;
  /** The thread root's id — `komnet read <room> --thread <id>` opens it. */
  thread: string;
  from: string;
  kind: string;
  needs: string;
  /** Who it WAS addressed to, so a reader can tell whether it concerns them. */
  mentions: string[];
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
  /**
   * What is happening on the network **outside** this agent's inbox.
   *
   * An agent that joined `general` and waits sees only what was addressed to
   * it, so a room created this morning and the conversation the team started in
   * it are invisible — not filtered out, never mentioned. Waiting looks the
   * same as there being nothing to know, and the agent finds out when someone
   * eventually complains it was not there.
   *
   * Both of these cost **nothing extra**: the room list arrives with the same
   * `ls-remote` every poll already makes, and the thread roots are messages this
   * sync fetched and parsed anyway. Neither changes routing or the inbox — they
   * are ambient awareness, and a reader decides whether to act.
   */
  discovered: RoomDiscovery[];
  /** Conversations that started in a followed room without addressing us. */
  startedThreads: ThreadStart[];
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

/**
 * Whether this agent's view of the network can be trusted right now.
 *
 * Carried on every read, because a read answers from a local cache that cannot
 * distinguish "nothing was said" from "nothing has reached this machine since
 * Tuesday".
 */
/**
 * One room holding commits the remote has not seen.
 *
 * A message here is **written and durable**, not lost: it is committed on the
 * room branch and goes out on the next successful sync. Saying which of those
 * two states a send reached is the difference between "retry it" and "leave it
 * alone", and getting that wrong produces permanent duplicates in a log nobody
 * can edit.
 */
export interface OutboxEntry {
  roomId: string;
  ahead: number;
  /** When this room first had something waiting, RFC 3339 UTC. */
  since: string | null;
  /** Why it is still waiting, as git said it — without komnet's own flags. */
  reason: string | null;
}

export interface TransportHealth {
  /** When sync last completed. Null means it never has. */
  lastSyncAt: string | null;
  /** Seconds since that, or null if it never synced. */
  ageSeconds: number | null;
  /** True when sync is failing, or has never run. Treat results as partial. */
  degraded: boolean;
  /** Why, when known — the message from the failure sync recorded. */
  reason?: string;
  /** When it started failing, so a reader sees how long this has been true. */
  failingSince?: string;
}

/**
 * Whether a mention will actually reach the agent it names.
 *
 * Three answers, and the distinction between the last two is the whole point:
 * an agent that publishes no subscription list is `unknown`, NOT `no`. Older
 * clients do not publish one, and reporting a confident "they will not see
 * this" about a peer who is reading fine would be worse than saying nothing.
 */
export type DeliveryOutlook = "reaches" | "misses" | "unknown";

export interface DeliveryForecast {
  agent: string;
  outlook: DeliveryOutlook;
  /** Why, in one clause, for a human or an agent to relay. */
  reason: string;
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
  /**
   * Unfinished collaborative work this agent is party to, across every room.
   *
   * Status answers "what is waiting for me", and until now that meant unread
   * messages only — so an agent could report a clean network while owning a
   * task that had been stalled for a week.
   */
  tasks: AgendaCounts;
  /**
   * The network beside this agent — rooms it has not joined, and conversations
   * that started in the ones it has without addressing it.
   *
   * On status because status is the cheap check an agent already makes, and
   * because "nothing is waiting for me" was previously answerable without ever
   * revealing that the team had moved somewhere else. Counts and ids, never
   * bodies; nothing here is delivery.
   */
  surroundings: Surroundings;
  /**
   * Which pending messages bear on the work in hand — ids and reasons only,
   * never bodies.
   *
   * This is what makes status safe to call part-way through long work. "Is
   * there mail" was only ever answerable by reading the mail, so an agent that
   * wanted to know whether it was needed had to accept a context switch to find
   * out it was not. See `classifyAttention`.
   */
  attention: Attention;
  /** Whether the local view can be trusted. See `TransportHealth`. */
  health: TransportHealth;
}

/**
 * One piece of work this session should pick up where the last one left off.
 *
 * The agenda answers "what do I owe"; this answers the narrower question that
 * actually starts a session well — "what was I in the middle of, and what did I
 * leave behind".
 */
export interface ResumePoint {
  room: string;
  taskId: string;
  title: string;
  definition: string;
  health: TaskHealth;
  updatedAt: string;
  /**
   * The last accepted event, which is where the previous session recorded what
   * it had done and what came next. Absent only when the task's thread cannot
   * be read back — a room that failed to open, or history sealed past the live
   * window.
   */
  last?: { action: string; ts: string; from: string; body: string };
}

/**
 * One network, on this machine.
 *
 * Operates in **direct mode** (ADR 0005): every mutating call takes an
 * exclusive lock and runs git itself. The daemon will reuse these same methods
 * behind its socket — the logic lives here precisely so CLI and daemon cannot
 * drift apart.
 */
/**
 * Make a local, non-bare transport repository accept pushes.
 *
 * A transport that is a plain path on disk — the "no server at all" setup the
 * quickstart recommends — refuses a push to whichever branch it happens to have
 * checked out. In practice an editor holds `room/<id>` open and every send to
 * that room is rejected, which reads as a komnet fault rather than a git
 * default. `updateInstead` accepts the push and fast-forwards the worktree when
 * it is clean, and still refuses when it is dirty, so nobody's edits are lost.
 *
 * Best effort by design: a remote URL, an unwritable path, or a bare repo (which
 * has no checked-out branch and does not need this) all leave it alone.
 */
async function hardenLocalTransport(remote: string, runner: GitRunner): Promise<void> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote) || remote.includes("@")) return;
  try {
    const bare = await runner.text(["rev-parse", "--is-bare-repository"], { cwd: remote });
    if (bare.trim() === "true") return;
    await runner.run(["config", "receive.denyCurrentBranch", "updateInstead"], { cwd: remote });
  } catch {
    // Not a git repo, not reachable, or not ours to configure.
  }
}

/**
 * Shorten a sync failure to the part someone can act on.
 *
 * A raw `GitError` carries the whole command line and every line of git's
 * stderr. Carried verbatim into a health warning it buries the one useful
 * sentence and bloats every JSON read that reports it, so keep the diagnosis
 * and drop the transcript.
 */
function conciseFailure(error: unknown): string {
  // Report what the transport said, not what komnet concluded from it. A push
  // that exhausts its ladder wraps the real failure as its `cause`, and "push
  // did not converge after 3 attempts" tells a user nothing they can act on,
  // while "Permission denied (publickey)" tells them exactly what to fix.
  const root = (error as { cause?: unknown } | null)?.cause;
  const full = describeError(root ?? error);
  // `git <flags...> failed (128): fatal: ...` — the flags are ours, not news.
  const detail = /failed \(\d+\): ([\s\S]+)$/.exec(full)?.[1] ?? full;
  const firstLine = detail.split("\n").find((line) => line.trim() !== "") ?? detail;
  const trimmed = firstLine.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed;
}

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

  /** Work a person has agreed this agent may take on. Local, never published. */
  get approvals(): ApprovalStore {
    return new ApprovalStore(this.layout.approvalsPath(this.id));
  }

  /**
   * Machine-local policy, re-read rather than cached.
   *
   * A person edits this file expecting the next command to obey it; caching it
   * for the life of a daemon would mean tightening the rules had no effect
   * until a restart, which is the wrong way round for a control.
   */
  async policy(): Promise<ResolvedPolicy> {
    return await loadLocalPolicy(this.layout);
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
    await hardenLocalTransport(remote, runner);

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
    // The profile is advisory. Its commit is already durable locally if only
    // the push failed, and record-outbox sync will retry; onboarding must not
    // fail after the identity card has already registered successfully.
    await network.publishAgentProfile().catch(() => undefined);
    return { network, createdNetwork };
  }

  /**
   * Publish (or refresh) this agent's card on `main`. Own file only.
   *
   * Returns whether anything was actually pushed — presence is published on
   * transition, and the caller uses this to avoid logging a no-op.
   */
  private get agentsContext(): AgentsContext {
    return {
      identity: this.identity,
      subscriptions: this.config.subscriptions,
      repo: this.repo,
      recordWorktree: this.recordWorktree,
      lockPath: this.lockPath,
      gitIdentity: async () => await this.gitIdentity(),
      read: async (roomId) => await this.read(roomId),
    };
  }

  async publishAgentCard(
    extras: {
      expertise?: string[];
      speaksFor?: string[];
      presence?: "live" | "away";
      session?: string;
    } = {},
  ): Promise<boolean> {
    return await agents.publishAgentCard(this.agentsContext, extras);
  }

  async listAgents(): Promise<AgentCard[]> {
    return await agents.listAgents(this.agentsContext);
  }

  /** Publish this agent's cooperative description on `main`. Own file only. */
  async publishAgentProfile(
    update: AgentProfileUpdate = {},
    runtime?: AgentRuntimeEnvironment,
  ): Promise<boolean> {
    return await agents.publishAgentProfile(this.agentsContext, update, runtime);
  }

  async getAgentProfile(agentId = this.identity.id): Promise<AgentProfile | null> {
    return await agents.getAgentProfile(this.agentsContext, agentId);
  }

  async listAgentProfiles(): Promise<AgentProfile[]> {
    return await agents.listAgentProfiles(this.agentsContext);
  }

  /** Cards with the scan-friendly role, preserving every existing card field. */
  async listAgentDirectory(): Promise<AgentDirectoryEntry[]> {
    return await agents.listAgentDirectory(this.agentsContext);
  }

  /** The roster, with presence corrected by observed activity. */
  async presenceRoster(): Promise<PresenceRow[]> {
    return await agents.presenceRoster(this.agentsContext);
  }

  // -------------------------------------------------------------------- rooms

  private get roomsContext(): RoomsContext {
    return {
      networkId: this.id,
      agentId: this.identity.id,
      layout: this.layout,
      repo: this.repo,
      state: this.state,
      config: this.config,
      recordWorktree: this.recordWorktree,
      lockPath: this.lockPath,
      publishAgentCard: async () => await this.publishAgentCard(),
    };
  }

  async listRooms(): Promise<RoomInfo[]> {
    return await rooms.listRooms(this.roomsContext);
  }

  /** Create a room: an orphan branch for its log, plus its config on `main`. */
  async createRoom(
    roomId: string,
    options: { title?: string; purpose?: string; replyBudget?: number } = {},
  ): Promise<RoomConfig> {
    return await rooms.createRoom(this.roomsContext, roomId, options);
  }

  async joinRoom(roomId: string): Promise<void> {
    await rooms.joinRoom(this.roomsContext, roomId);
  }

  async leaveRoom(roomId: string): Promise<void> {
    await rooms.leaveRoom(this.roomsContext, roomId);
  }

  /** Kept on the facade: sending, sync and the reading domain all need it. */
  private async ensureRoomWorktree(roomId: string): Promise<string> {
    return await rooms.ensureRoomWorktree(this.roomsContext, roomId);
  }

  async readRoomConfig(roomId: string): Promise<RoomConfig | null> {
    return await rooms.readRoomConfig(this.roomsContext, roomId);
  }

  // ------------------------------------------------------------------ sending

  async send(
    roomId: string,
    input: SendInput,
    extraRules: readonly SecretRule[] = [],
  ): Promise<Message> {
    // Sending into a room you do not follow posts a question whose answer you
    // will never see: routing delivers replies only within subscriptions.
    this.assertSubscribed(roomId, "send to");
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
      const pressureEligible =
        input.task === undefined &&
        (input.review === undefined || input.review.state === "discussing");

      let pressure: ThreadPressure | null = null;
      if (authorKind === "agent" && thread !== undefined && pressureEligible) {
        const messages =
          existingMessages ?? (await new RoomStore(worktree, roomId).readAll(() => undefined));
        existingMessages = messages;
        const inThread = messages.filter((m) => m.header.thread === thread);

        // Discussion around unfinished task work is exempt.
        //
        // The budget exists to stop two agents ping-ponging with nothing to
        // show for it. A task thread already has a stronger bound — it must
        // reach `completed` or `cancelled`, and its silence deadline surfaces
        // it if it does not — so applying the generic budget here only splits
        // one engagement across several threads and loses the continuity that
        // long-running work depends on. The exemption ends when the task does.
        if (!activeTaskThreads(inThread).has(thread)) {
          const budget =
            (await this.readRoomConfig(roomId))?.policy.replyBudget ??
            DEFAULT_ROOM_POLICY.replyBudget;
          pressure =
            input.review?.state === "discussing"
              ? assessReviewDiscussionPressure(messages, thread, input.review.id, budget)
              : assessThreadPressure(messages, thread, budget);
        }
      }
      // Hitting the budget REFUSES locally; it does not rewrite the message.
      //
      // It used to convert the agent's own message into a permanent
      // `needs: human` on the shared log — burning the one marker that is
      // supposed to mean "a person must decide this" on what was usually a
      // conversation that had merely gone on a while. A marker spent on routine
      // traffic stops meaning anything, and it is permanent. Refusing keeps the
      // record clean and still puts the decision in front of a person.
      if (pressure?.shouldPark === true) {
        throw new ReplyBudgetExceededError(
          roomId,
          thread as string,
          pressure.consecutiveAgentMessages,
        );
      }
      const needs = input.needs ?? "none";
      const tags = [...(input.tags ?? [])];
      const review = input.review;

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
        ...(input.task === undefined ? {} : { task: input.task }),
        ...(input.claim === undefined ? {} : { claim: input.claim }),
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
        this.state.setMeta(`queuedSince:${roomId}`, "");
        this.state.setMeta(`queuedReason:${roomId}`, "");
      } catch (error) {
        // The commit is already durable, so a push that did not go through is
        // not a lost message — it is a queued one, and the next sync sends it.
        //
        // This used to rethrow anything that was not `PushExhaustedError`, on
        // the reasoning that an auth failure "needs a human". It does — but the
        // form that took was a raw `git ... push failed (128): Permission denied
        // (publickey)` presented as a failed send, for a message that was safe
        // and did go out on the next sync. A sender who believes that error
        // retries, and the duplicate is permanent. Naming the problem while
        // saying the message is safe serves the human better than an error that
        // implies data loss.
        this.state.setMeta(`queuedSince:${roomId}`, new Date().toISOString());
        this.state.setMeta(`queuedReason:${roomId}`, conciseFailure(error));
      }

      const newHead = await this.repo.runner.text(["rev-parse", "HEAD"], { cwd: worktree });
      this.state.setHead(roomId, newHead);
      return message;
    });
  }

  /**
   * Will a message mentioning these agents actually reach them?
   *
   * Routing delivers only within a recipient's subscriptions, so mentioning an
   * agent that never joined the room produced silence indistinguishable from
   * being ignored — a question could sit unanswered for a day with both sides
   * believing the other was slow. Cards now publish subscriptions, so this is
   * answerable before the mistake costs anything.
   *
   * Advisory in the positive direction and reliable in the negative: a peer may
   * have joined a second ago and not pushed, but a room missing from a card
   * that lists rooms is one they are very unlikely to be reading.
   */
  async forecastDelivery(roomId: string, agents: readonly string[]): Promise<DeliveryForecast[]> {
    if (agents.length === 0) return [];
    const cards = new Map((await this.listAgents()).map((card) => [card.id, card]));
    return agents
      .filter((agent) => agent !== MENTION_ROOM && agent !== this.identity.id)
      .map((agent) => {
        const card = cards.get(agent);
        if (card === undefined) {
          return {
            agent,
            outlook: "unknown" as const,
            // Deliberately not "check the spelling". The roster is this
            // machine's last-fetched copy of `main`, so a peer that registered
            // after the last sync is missing from it — and telling a sender
            // their correct id is wrong sends them hunting for a typo while the
            // message they just sent lands perfectly well.
            reason: "not in this machine's copy of the roster — either new, or the id is wrong",
          };
        }
        if (card.subscriptions === undefined) {
          return {
            agent,
            outlook: "unknown" as const,
            reason: "publishes no room list (older komnet), so delivery cannot be predicted",
          };
        }
        return card.subscriptions.includes(roomId)
          ? { agent, outlook: "reaches" as const, reason: `follows #${roomId}` }
          : {
              agent,
              outlook: "misses" as const,
              reason: `does not follow #${roomId}, so routing will not deliver this`,
            };
      });
  }

  private get reviewsContext(): ReviewsContext {
    return {
      agentId: this.identity.id,
      send: async (roomId, input) => await this.send(roomId, input),
      read: async (roomId) => await this.read(roomId),
      requireApproval: async (kind, roomId, id, requester) => {
        await this.requireApproval(kind, roomId, id, requester);
      },
    };
  }

  /** Create a targeted agent-to-agent repository review task. */
  async requestReview(roomId: string, input: ReviewRequestInput): Promise<Message> {
    return await reviews.requestReview(this.reviewsContext, roomId, input);
  }

  /** Current valid state of every review task in a room. */
  async listReviewTasks(roomId: string): Promise<ReviewTaskStatus[]> {
    return await reviews.listReviewTasks(this.reviewsContext, roomId);
  }

  /** Append one guarded state transition to an existing review task. */
  async updateReview(roomId: string, reviewId: string, input: ReviewUpdateInput): Promise<Message> {
    return await reviews.updateReview(this.reviewsContext, roomId, reviewId, input);
  }

  // ------------------------------------------------------------------- claims

  /**
   * Take an advisory lease on a shared resource.
   *
   * Syncs, writes, then syncs and re-reads before answering. That round trip is
   * the point: on a git transport two agents can both write a claim before
   * either sees the other, so a method that returned "granted" the moment it
   * pushed would be the same guess the chat-message convention made. The second
   * read reports who actually won, deterministically, on both machines.
   *
   * Still advisory. Nothing stops a peer ignoring it — but a caller that checks
   * `granted` gets a real answer, and every hold expires on its own so a crashed
   * holder cannot strand the resource.
   */
  /**
   * Everything resource claiming is allowed to reach.
   *
   * Built here rather than handing over `this`, so the domain's dependencies
   * are a list you can read instead of whatever it happens to call through
   * `this` — and so the private guards stay private.
   */
  private get claimsContext(): ClaimsContext {
    return {
      agentId: this.identity.id,
      assertSubscribed: (roomId, verb) => {
        this.assertSubscribed(roomId, verb);
      },
      sync: async () => await this.sync(),
      send: async (roomId, input) => await this.send(roomId, input),
      read: async (roomId) => await this.read(roomId),
    };
  }

  async claimResource(
    roomId: string,
    resource: string,
    options: { ttlSeconds?: number; note?: string } = {},
  ): Promise<{ granted: boolean; status: ClaimStatus | null }> {
    return await claims.claimResource(this.claimsContext, roomId, resource, options);
  }

  /** Release a resource this agent holds. Releasing something you do not hold is a no-op. */
  async releaseResource(roomId: string, resource: string, note?: string): Promise<boolean> {
    return await claims.releaseResource(this.claimsContext, roomId, resource, note);
  }

  /** Current holder of every claimed resource in a room, expiry included. */
  async listClaims(roomId: string, options: { sync?: boolean } = {}): Promise<ClaimStatus[]> {
    return await claims.listClaims(this.claimsContext, roomId, options);
  }

  /** Create a task targeted to one agent or free for any room subscriber to claim. */
  private get approvalsContext(): ApprovalsContext {
    return {
      agentId: this.identity.id,
      store: this.approvals,
      policy: async () => await this.policy(),
    };
  }

  private get tasksContext(): TasksContext {
    return {
      agentId: this.identity.id,
      subscriptions: this.config.subscriptions,
      send: async (roomId, input) => await this.send(roomId, input),
      read: async (roomId) => await this.read(roomId),
      requireApproval: async (kind, roomId, id, requester) => {
        await this.requireApproval(kind, roomId, id, requester);
      },
    };
  }

  async createTask(roomId: string, input: TaskCreateInput): Promise<Message> {
    return await tasks.createTask(this.tasksContext, roomId, input);
  }

  /** Current valid state of every collaborative task in a room. */
  async listTasks(roomId: string): Promise<TaskStatus[]> {
    return await tasks.listTasks(this.tasksContext, roomId);
  }

  /** One task with its whole accepted history — the resumption path. */
  async showTask(roomId: string, taskId: string): Promise<TaskDetail> {
    return await tasks.showTask(this.tasksContext, roomId, taskId);
  }

  /** Unfinished work involving this agent, across every subscribed room. */
  async agenda(options: AgendaOptions = {}): Promise<Agenda> {
    return await tasks.agenda(this.tasksContext, options);
  }

  /** What this session was in the middle of, with the last thing it recorded. */
  async resume(limit = 3): Promise<ResumePoint[]> {
    return await tasks.resume(this.tasksContext, limit);
  }

  /** Kept on the facade: reviews gate their claim through it too. */
  private async requireApproval(
    kind: ApprovalKind,
    roomId: string,
    id: string,
    requester: string,
  ): Promise<void> {
    await approvals.requireApproval(this.approvalsContext, kind, roomId, id, requester);
  }

  /** Record that a person approved this agent taking on one piece of work. */
  async approveInboundWork(
    kind: ApprovalKind,
    roomId: string,
    id: string,
    note?: string,
  ): Promise<ApprovalRecord> {
    return await approvals.approveInboundWork(this.approvalsContext, kind, roomId, id, note);
  }

  async listApprovals(): Promise<ApprovalRecord[]> {
    return await approvals.listApprovals(this.approvalsContext);
  }

  async revokeApproval(kind: ApprovalKind, id: string): Promise<boolean> {
    return await approvals.revokeApproval(this.approvalsContext, kind, id);
  }

  /** Claim a task for this agent and publish that assignment to its participants. */
  async claimTask(roomId: string, taskId: string, body: string): Promise<Message> {
    return await tasks.claimTask(this.tasksContext, roomId, taskId, body);
  }

  /** Append one guarded task refinement, progress update, or lifecycle transition. */
  async updateTask(roomId: string, taskId: string, input: TaskUpdateInput): Promise<Message> {
    return await tasks.updateTask(this.tasksContext, roomId, taskId, input);
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
   * Stamp this agent as seen, without sending anything.
   *
   * What `live` asserts is narrow and worth stating: *an agent session
   * announced itself at this timestamp*. Nothing here keeps that true
   * afterwards — readers age the stamp themselves (`observedPresenceStatus`),
   * so it reads live for a few minutes and away once it has gone cold. There is
   * no heartbeat, so announcing again while the stamp is still fresh writes
   * nothing at all.
   *
   * `away` is the other direction and stays a deliberate declaration: it says
   * "I am leaving now" rather than waiting for silence to say it.
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
    // Activity-corrected, so a peer that is mid-task does not read as absent
    // and provoke "nobody is live — do not wait on it".
    const peers: HandshakePeer[] = (await this.presenceRoster())
      .filter((row) => row.id !== self)
      .map((row) => ({
        id: row.id,
        status: row.status,
        lastSeen: row.lastSeen,
        lastActivity: row.lastActivity,
        tool: row.tool,
        human: row.human,
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
   * becomes true. It writes only this agent's own receipt file, one of the
   * agent-owned records that `mayModify` lets it rewrite.
   *
   * Returns false when nothing moved: a receipt that re-published an unchanged
   * high-water mark would put a commit on `main` every time an agent looked at
   * an empty inbox.
   */
  async publishReceipt(roomId: string): Promise<boolean> {
    // What this agent has READ, not what it has finished. See `recordSeen`.
    const readThrough = this.state.getMeta(`seenThrough:${roomId}`);
    if (readThrough === null || readThrough === "") return false;
    const seen = this.state
      .listInbox({ room: roomId, includeProcessed: true })
      .filter((item) => item.id <= readThrough);

    return await FileLock.withLock(this.lockPath, async () => {
      const path = receiptPath(roomId, this.identity.id);
      const absolute = join(this.recordWorktree, path);
      if (await exists(absolute)) {
        try {
          const previous = parseReadReceipt(await readFile(absolute, "utf8"));
          if (previous.readThrough === readThrough && previous.count === seen.length) {
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
          count: seen.length,
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

  /**
   * What actually happened to one message, per recipient.
   *
   * "Sent" was the only answer komnet could give, and it means the narrowest
   * possible thing: this machine wrote a commit. Everything a sender actually
   * wants to know — did it reach the remote, is that agent even in this room,
   * have they read it, have they answered — was spread across `outbox`,
   * `agents`, `receipts` and reading the thread, so in practice nobody assembled
   * it and a message sitting unread looked identical to one being ignored.
   *
   * Every state here is **derived from git**, and each is honest about its own
   * limits rather than upgrading a weaker signal into a stronger one:
   *
   * - `stored` / `pushed` — a local commit, then the remote's copy of the room
   *   branch containing this exact path. Ours to know for certain.
   * - `routable` — their published card lists this room. Reliable in the
   *   negative (ADR 0021): if it is missing, routing will not deliver.
   * - `read` — their own read receipt covers this id. It says an agent
   *   processed its inbox past this point, never that a model understood it.
   * - `answered` — a later message from them in the same thread. The strongest
   *   available evidence, and still not proof they agreed.
   *
   * There is deliberately no `session-activated` state. komnet never starts an
   * agent (ADR 0006), so nothing here can report one waking up; what it can say
   * is whether the other machine has a daemon publishing presence at all, which
   * is the difference between "will see this shortly" and "will see it when a
   * person next opens their editor".
   */
  async trace(messageId: string): Promise<MessageTrace | null> {
    const found = await this.findSentMessage(messageId);
    if (found === null) return null;
    const { message, roomId } = found;

    const path = messagePath(message.header);
    const remoteRef = `refs/remotes/${REMOTE}/${roomRef(roomId)}`;
    const pushed = (await this.repo.readFile(remoteRef, path)) !== null;

    const cards = new Map((await this.listAgents()).map((card) => [card.id, card]));
    const receipts = new Map(
      (await this.readReceipts(roomId)).map((receipt) => [receipt.agent, receipt]),
    );
    // The whole thread, so "answered" means a reply that came AFTER this one.
    const thread = await this.read(roomId, { thread: message.header.thread, limit: 500 });

    const addressed = message.header.mentions.includes(MENTION_ROOM)
      ? [...cards.values()]
          .filter((card) => card.id !== this.identity.id)
          .filter((card) => card.subscriptions?.includes(roomId) ?? true)
          .map((card) => card.id)
      : message.header.mentions.filter((agent) => agent !== this.identity.id);

    const recipients: TraceRecipient[] = addressed.map((agent) => {
      const card = cards.get(agent);
      const receipt = receipts.get(agent);
      const answered = thread.some(
        (other) => other.header.from === agent && other.header.id > message.header.id,
      );
      return {
        agent,
        routable:
          card === undefined
            ? "unknown"
            : card.subscriptions === undefined
              ? "unknown"
              : card.subscriptions.includes(roomId)
                ? "yes"
                : "no",
        read: receipt?.readThrough != null && receipt.readThrough >= message.header.id,
        ...(receipt?.updatedAt === undefined ? {} : { readAt: receipt.updatedAt }),
        answered,
      };
    });

    return {
      id: message.header.id,
      room: roomId,
      thread: message.header.thread,
      from: message.header.from,
      needs: message.header.needs,
      stored: true,
      pushed,
      recipients,
    };
  }

  /** Locate a message this agent can see, by id, across the rooms it follows. */
  private async findSentMessage(
    messageId: string,
  ): Promise<{ message: Message; roomId: string } | null> {
    for (const roomId of this.config.subscriptions) {
      const worktree = this.layout.roomWorktree(this.id, roomId);
      if (!(await exists(worktree))) continue;
      const store = new RoomStore(worktree, roomId);
      const messages = await store.readAll(() => undefined);
      const message = messages.find((candidate) => candidate.header.id === messageId);
      if (message !== undefined) return { message, roomId };
    }
    return null;
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

  private get readingContext(): ReadingContext {
    return {
      networkId: this.id,
      layout: this.layout,
      repo: this.repo,
      subscriptions: this.config.subscriptions,
      assertSubscribed: (roomId, verb) => {
        this.assertSubscribed(roomId, verb);
      },
      ensureRoomWorktree: async (roomId) => await this.ensureRoomWorktree(roomId),
    };
  }

  async read(
    roomId: string,
    options: { limit?: number; thread?: string } = {},
  ): Promise<Message[]> {
    return await reading.read(this.readingContext, roomId, options);
  }

  /** Read past the live window, via git history. */
  async history(
    roomId: string,
    options: { since?: string; limit?: number } = {},
  ): Promise<Message[]> {
    return await reading.history(this.readingContext, roomId, options);
  }

  /** Substring search across the live window of subscribed rooms. */
  async search(
    query: string,
    options: { room?: string; limit?: number } = {},
  ): Promise<{ room: string; message: Message }[]> {
    return await reading.search(this.readingContext, query, options);
  }

  // ------------------------------------------------------------------ sealing

  private get sealingContext(): SealingContext {
    return {
      networkId: this.id,
      agentId: this.identity.id,
      remote: this.config.remote,
      subscriptions: this.config.subscriptions,
      layout: this.layout,
      repo: this.repo,
      state: this.state,
      lockPath: this.lockPath,
      readRoomConfig: async (roomId) => await this.readRoomConfig(roomId),
    };
  }

  /** Only git config and the manifest — deliberately not the sealing context. */
  private get authenticityContext(): AuthenticityContext {
    return { runner: this.repo.runner, recordWorktree: this.recordWorktree };
  }

  /** The git identity this machine commits with. */
  async gitIdentity(): Promise<{ name: string; email: string } | null> {
    return await authenticity.gitIdentity(this.authenticityContext);
  }

  /** SSH key used for `authenticity: signed`, or null when none is configured. */
  private async signingKeyPath(): Promise<string | null> {
    return await authenticity.signingKeyPath(this.authenticityContext);
  }

  /** The network manifest from `main`, which carries the authenticity mode. */
  async readManifest(): Promise<NetManifest | null> {
    return await authenticity.readManifest(this.authenticityContext);
  }

  async authenticityMode(): Promise<AuthenticityMode> {
    return await authenticity.authenticityMode(this.authenticityContext);
  }

  /** What sealing this room would do, without touching anything. */
  async sealDecision(roomId: string): Promise<SealDecision> {
    return await sealing.sealDecision(this.sealingContext, roomId);
  }

  /**
   * Compact a room: merge its live branch into `main`, write a digest, promote
   * decisions, then prune the sealed messages out of both trees.
   */
  async seal(roomId: string): Promise<SealResult> {
    return await sealing.seal(this.sealingContext, roomId);
  }

  /** Rooms whose live window has outgrown their retention policy. */
  async roomsNeedingSeal(): Promise<SealDecision[]> {
    return await sealing.roomsNeedingSeal(this.sealingContext);
  }

  private get inboxContext(): InboxContext {
    return {
      state: this.state,
      assertSubscribed: (roomId, verb) => {
        this.assertSubscribed(roomId, verb);
      },
    };
  }

  /** Nothing in common with the inbox but a section heading: git, not the state db. */
  private get outboxContext(): OutboxContext {
    return {
      networkId: this.id,
      layout: this.layout,
      repo: this.repo,
      state: this.state,
      subscriptions: this.config.subscriptions,
      remote: this.config.remote,
      recordWorktree: this.recordWorktree,
    };
  }

  inbox(query: InboxQuery = {}): InboxItem[] {
    return inboxOps.inbox(this.inboxContext, query);
  }

  /**
   * Mark items processed. `needs: human` items are refused — only an answer
   * recorded through the human-relay path clears those.
   */
  drainInbox(ids: readonly string[]): { drained: number; refused: string[] } {
    return inboxOps.drainInbox(this.inboxContext, ids);
  }

  // ------------------------------------------------------------------- outbox

  /** Rooms holding local commits the remote has not seen. */
  async outbox(): Promise<OutboxEntry[]> {
    return await outboxOps.outbox(this.outboxContext);
  }

  /** Push anything queued while offline. */
  async drainOutbox(): Promise<{ roomId: string; pushed: number }[]> {
    return await outboxOps.drainOutbox(this.outboxContext);
  }

  /** Keep the record branch convergent, like the room outboxes. */
  private async drainRecordOutbox(): Promise<void> {
    await outboxOps.drainRecordOutbox(this.outboxContext);
  }

  // --------------------------------------------------------------------- sync

  /**
   * Whether this agent's view of the network can be trusted right now.
   *
   * Reads answer from the local cache, so a transport that has stopped working
   * produces an empty inbox rather than an error — and an agent reports "no new
   * messages" to its human while dozens sit unfetched on the remote. That
   * happened. The cache cannot tell the difference on its own, so sync records
   * whether it last succeeded and every read carries the answer.
   */
  health(now = Date.now()): TransportHealth {
    // `setMeta(key, "")` is how a value is cleared, and `getMeta` returns that
    // empty string rather than null — so an emptied key must read as absent or
    // the first success would leave the network degraded forever.
    const meta = (key: string): string | null => {
      const value = this.state.getMeta(key);
      return value === null || value === "" ? null : value;
    };
    const lastSyncAt = meta("lastSyncAt");
    const failure = meta("lastSyncError");
    const failedAt = meta("lastSyncErrorAt");
    const syncedMs = lastSyncAt === null ? null : Date.parse(lastSyncAt);
    const ageSeconds =
      syncedMs === null || !Number.isFinite(syncedMs)
        ? null
        : Math.max(0, Math.round((now - syncedMs) / 1000));

    return {
      lastSyncAt,
      ageSeconds,
      // Never synced is not "fine, nothing to report" — it is the state in which
      // an empty inbox is least trustworthy.
      degraded: failure !== null || lastSyncAt === null,
      ...(failure === null ? {} : { reason: failure }),
      ...(failedAt === null ? {} : { failingSince: failedAt }),
    };
  }

  /**
   * Refuse to answer for a room this agent does not follow.
   *
   * Routing only ever delivers within subscribed rooms, so the cache holds
   * nothing for any other room — and returning `[]` states, falsely, that the
   * room is quiet. An unsubscribed read is a mistake worth surfacing, not a
   * result worth reporting.
   */
  private assertSubscribed(roomId: string, verb: string): void {
    if (this.config.subscriptions.includes(roomId)) return;
    throw new NotSubscribedError(roomId, verb);
  }

  async sync(): Promise<SyncReport> {
    try {
      return await this.syncOnce();
    } catch (error) {
      // Record before rethrowing. The caller may swallow this — a daemon logs
      // and retries, an editor may show nothing — and the whole point is that
      // the next READ can still tell someone the view is not to be trusted.
      try {
        this.state.setMeta("lastSyncError", conciseFailure(error));
        // Keep the FIRST failure time, so a reader learns how long this has
        // been broken rather than only that it is broken now. A cleared key
        // reads as "" rather than null, so both count as "no failure yet".
        const since = this.state.getMeta("lastSyncErrorAt");
        if (since === null || since === "") {
          this.state.setMeta("lastSyncErrorAt", new Date().toISOString());
        }
      } catch {
        // A closed database during shutdown must not replace the real error.
      }
      throw error;
    }
  }

  private async syncOnce(): Promise<SyncReport> {
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
        discovered: this.noteUnsubscribedRooms(diff.unsubscribed, remote.rooms),
        startedThreads: [],
      };

      // Agent cards, profiles, and room policy live on main. Refresh it before verifying
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
          } else if (isThreadRoot(message.header) && message.header.from !== this.identity.id) {
            // Recorded, not delivered — somebody opened a conversation in a room
            // this agent follows and addressed it elsewhere. Routing is right to
            // keep it out of the inbox, but "a discussion started next to you"
            // is the thing a waiting agent has no other way to learn. Roots
            // only: every reply after this belongs to a thread already named.
            report.startedThreads.push({
              room: message.header.room,
              thread: message.header.thread,
              from: message.header.from,
              kind: message.header.kind,
              needs: message.header.needs,
              mentions: [...message.header.mentions],
            });
          }
        }
        this.state.setHead(change.roomId, change.to);
      }

      this.noteStartedThreads(report.startedThreads);
      this.state.setMeta("lastSyncAt", new Date().toISOString());
      // A sync that got this far worked, so the transport is trustworthy again.
      this.state.setMeta("lastSyncError", "");
      this.state.setMeta("lastSyncErrorAt", "");
      return report;
    });
  }

  /**
   * Track rooms this agent does not follow, so each is news exactly once.
   *
   * Kept in `meta` rather than in the delivery head table on purpose. Those
   * heads mean "everything up to here has been processed for delivery", and
   * writing one for a room nobody has joined would silently skip that room's
   * entire backlog on the day someone did join it. `meta` also survives a
   * schema bump, so noticing rooms never costs anyone a re-delivered inbox.
   */
  private noteUnsubscribedRooms(
    unsubscribed: readonly string[],
    remote: ReadonlyMap<string, string>,
  ): RoomDiscovery[] {
    const known = readJsonMeta<Record<string, string>>(this.state, SEEN_ROOMS_KEY, {});
    const discovered: RoomDiscovery[] = [];
    const next: Record<string, string> = {};
    for (const roomId of unsubscribed) {
      const head = remote.get(roomId);
      if (head === undefined) continue;
      next[roomId] = head;
      const previous = known[roomId];
      if (previous === head) continue;
      discovered.push({ roomId, state: previous === undefined ? "appeared" : "active" });
    }
    // Replaced rather than merged: a room this agent has since joined belongs
    // to delivery now, and one that vanished is not news any more.
    this.state.setMeta(SEEN_ROOMS_KEY, JSON.stringify(next));
    return discovered;
  }

  /**
   * Remember conversations that started beside this agent, newest last.
   *
   * Bounded and advisory. This is context, not mail: it never gates delivery,
   * and losing it costs nothing, so it lives in `meta` instead of earning a
   * schema bump that would make every existing install re-deliver its inbox.
   */
  private noteStartedThreads(started: readonly ThreadStart[], now = new Date()): void {
    if (started.length === 0) return;
    const at = now.toISOString();
    const kept = [
      ...readJsonMeta<StoredThreadStart[]>(this.state, STARTED_THREADS_KEY, []).filter(
        (entry) => !started.some((fresh) => fresh.thread === entry.thread),
      ),
      ...started.map((start) => ({ ...start, at })),
    ];
    this.state.setMeta(
      STARTED_THREADS_KEY,
      JSON.stringify(kept.slice(Math.max(0, kept.length - MAX_REMEMBERED_THREADS))),
    );
  }

  /**
   * What is going on around this agent, as opposed to addressed to it.
   *
   * The gap this closes: an agent joins one room, waits, and is structurally
   * blind to everything else — routing keeps other rooms out of its inbox, and
   * a conversation started next to it was never addressed to it either. Waiting
   * therefore looks exactly like there being nothing to know, right up until
   * somebody asks why it did not join in.
   *
   * Answered entirely from what earlier syncs already recorded: no network call,
   * no git. Nothing here is delivery — it is the network saying "this exists",
   * and the agent decides whether to `komnet room join` or read the thread.
   */
  surroundings(): Surroundings {
    const seen = readJsonMeta<Record<string, string>>(this.state, SEEN_ROOMS_KEY, {});
    const subscribed = new Set(this.config.subscriptions);
    return {
      rooms: Object.keys(seen)
        .filter((roomId) => !subscribed.has(roomId))
        .sort(),
      threads: readJsonMeta<StoredThreadStart[]>(this.state, STARTED_THREADS_KEY, []).filter(
        (entry) => subscribed.has(entry.room),
      ),
    };
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
    // One agenda pass serves both: the counts summarise what is owed, and the
    // in-flight threads are what make the pending messages classifiable.
    const agenda = await this.agenda({ limit: 0 });
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
      // Counts only: status is a summary, and the agenda itself is one call away.
      tasks: agenda.counts,
      surroundings: this.surroundings(),
      attention: classifyAttention(this.state.listInbox({}), new Set(agenda.inFlightThreads)),
      health: this.health(),
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
