import { homedir } from "node:os";
import { join } from "node:path";
import { assertAgentId, assertRoomId } from "@kom-net/protocol";

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

  agentInboxDir(agentId: string): string {
    return join(this.inboxDir, assertAgentId(agentId));
  }
}
