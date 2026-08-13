import { homedir } from "node:os";
import { join } from "node:path";
import { assertAgentId, assertRoomId, isUlid } from "@komnet/protocol";

/**
 * On-disk layout of local state (docs/design/02-architecture.md §3).
 *
 * Two properties matter and are relied on elsewhere:
 *  - worktrees share ONE object store, so ten subscribed rooms cost ten
 *    directories but one copy of the objects;
 *  - `state.db` is a cache. Deleting it loses nothing; it is rebuilt from git.
 */
export class Layout {
  readonly root: string;

  constructor(root?: string) {
    this.root = root ?? process.env["KOMNET_HOME"] ?? join(homedir(), ".komnet");
  }

  get configPath(): string {
    return join(this.root, "config.yaml");
  }

  /**
   * Machine-local policy, edited by a person and never rewritten by komnet.
   *
   * Separate from `config.yaml` because that file IS rewritten — on every
   * `room join`, `repo map`, and daemon subscription change — through a YAML
   * serialiser that discards comments. See `policy.ts`.
   */
  get policyPath(): string {
    return join(this.root, "policy.yaml");
  }

  /**
   * IPC socket. Filesystem permissions (0600) are the authentication — no port
   * is opened and nothing listens on TCP (ADR 0005).
   */
  get socketPath(): string {
    return join(this.root, "daemon.sock");
  }

  get logsDir(): string {
    return join(this.root, "logs");
  }

  /** Pending messages rendered as plain markdown, readable with no tooling. */
  get inboxDir(): string {
    return join(this.root, "inbox");
  }

  /** Machine-local detached worktrees prepared for repository reviews. */
  get reviewsDir(): string {
    return join(this.root, "reviews");
  }

  get reviewsLockPath(): string {
    return join(this.reviewsDir, ".lock");
  }

  reviewDir(reviewId: string): string {
    if (!isUlid(reviewId)) throw new TypeError(`invalid review id: ${reviewId}`);
    return join(this.reviewsDir, reviewId);
  }

  reviewWorktree(reviewId: string): string {
    return join(this.reviewDir(reviewId), "checkout");
  }

  reviewMetadataPath(reviewId: string): string {
    return join(this.reviewDir(reviewId), "metadata.json");
  }

  networkDir(networkId: string): string {
    return join(this.root, "networks", networkId);
  }

  /** The bare clone: the single object store all worktrees share. */
  gitDir(networkId: string): string {
    return join(this.networkDir(networkId), "git");
  }

  /** Worktree on `main` — grep across the whole record. */
  recordWorktree(networkId: string): string {
    return join(this.networkDir(networkId), "net");
  }

  /** Worktree on `room/<id>` — the live tail of one room. */
  roomWorktree(networkId: string, roomId: string): string {
    return join(this.networkDir(networkId), "rooms", assertRoomId(roomId));
  }

  /** Local cache: cursors, inbox index, presence. Rebuildable from git. */
  statePath(networkId: string): string {
    return join(this.networkDir(networkId), "state.db");
  }

  /** Durable outbox, so queued sends survive a restart or an offline week. */
  outboxDir(networkId: string): string {
    return join(this.networkDir(networkId), "outbox");
  }

  /**
   * Work a person has approved this agent to take on.
   *
   * A plain file rather than a row in `state.db`, because an approval is not
   * derivable from git and that database is discarded on a schema bump.
   */
  approvalsPath(networkId: string): string {
    return join(this.networkDir(networkId), "approvals.json");
  }

  agentInboxDir(agentId: string): string {
    return join(this.inboxDir, assertAgentId(agentId));
  }

  /**
   * Home for one locally-provisioned agent identity.
   *
   * Several agents on one machine — Claude and Codex, or two sessions of the
   * same tool — are separate participants, and each needs its own identity,
   * inbox, and cursors. Isolation is a whole `KOMNET_HOME` per agent rather
   * than a shared home with per-agent tables: it is the arrangement the test
   * suite has always used, so it is the one actually known to work, and it
   * keeps two agents from ever contending on one `state.db`.
   *
   * The cost is a clone per agent, which is what buys that isolation. For a
   * local transport that is cheap; for a large remote one, sharing the object
   * store is the obvious later optimisation.
   */
  agentHomeDir(agentId: string): string {
    return join(this.root, "agents", assertAgentId(agentId));
  }
}
