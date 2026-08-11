import { isMessagePath, parseMessage, type Message } from "@komnet/protocol";
import type { FileChangeStatus, Repo } from "../git/repo.ts";

/** A subscribed room whose head moved since we last looked. */
export interface RoomChange {
  roomId: string;
  /** Last head we processed; null when this room has never been seen. */
  from: string | null;
  to: string;
}

export interface HeadDiff {
  /** Subscribed rooms that moved — the only ones worth fetching. */
  changed: RoomChange[];
  /** Subscribed rooms whose remote branch has disappeared (room closed). */
  vanished: string[];
  /** Rooms on the remote we do not subscribe to. Surfaced for discovery only. */
  unsubscribed: string[];
}

/**
 * Compare the room→SHA map from one `ls-remote` against what we last processed.
 *
 * This is the whole point of per-room branches (ADR 0003): a single round trip
 * tells us precisely which rooms moved, so a fetch happens only when there is
 * genuinely something to fetch.
 */
export function diffRoomHeads(
  known: ReadonlyMap<string, string>,
  remote: ReadonlyMap<string, string>,
  subscribed: ReadonlySet<string>,
): HeadDiff {
  const changed: RoomChange[] = [];
  const unsubscribed: string[] = [];

  for (const [roomId, sha] of remote) {
    if (!subscribed.has(roomId)) {
      unsubscribed.push(roomId);
      continue;
    }
    const previous = known.get(roomId) ?? null;
    if (previous !== sha) changed.push({ roomId, from: previous, to: sha });
  }

  const vanished: string[] = [];
  for (const roomId of known.keys()) {
    if (subscribed.has(roomId) && !remote.has(roomId)) vanished.push(roomId);
  }

  changed.sort((a, b) => a.roomId.localeCompare(b.roomId));
  unsubscribed.sort();
  vanished.sort();
  return { changed, vanished, unsubscribed };
}

/**
 * A change to a message file that the append-only invariant forbids.
 *
 * Recorded rather than applied. Silently accepting a modification would let a
 * corrupted or hand-edited state propagate through the network as if it were
 * legitimate (ADR 0004).
 */
export interface Anomaly {
  path: string;
  status: FileChangeStatus;
}

export interface UnreadableMessage {
  path: string;
  error: unknown;
}

export interface RoomUpdate {
  roomId: string;
  from: string | null;
  to: string;
  messages: Message[];
  /** message id → email on the commit that added it, for authenticity checks. */
  commitAuthors: Map<string, string>;
  anomalies: Anomaly[];
  unreadable: UnreadableMessage[];
}

/**
 * Turn a moved room head into the messages it added.
 *
 * Only ADDED paths become messages. Modifications and deletions are anomalies —
 * except when they arrive as part of a seal, which the caller distinguishes by
 * checking for a seal commit.
 */
export async function collectRoomUpdate(repo: Repo, change: RoomChange): Promise<RoomUpdate> {
  const pathspec = `rooms/${change.roomId}/`;
  const update: RoomUpdate = {
    roomId: change.roomId,
    from: change.from,
    to: change.to,
    messages: [],
    commitAuthors: new Map(),
    anomalies: [],
    unreadable: [],
  };

  // Who committed each added file. `authenticity: git` compares this against
  // the `from` the message claims (spec §10) — without it, `from` is unchecked.
  const authorByPath = new Map<string, string>();
  const range = change.from === null ? change.to : `${change.from}..${change.to}`;
  for (const entry of await repo.logAddedPaths(range, pathspec)) {
    if (!authorByPath.has(entry.path)) authorByPath.set(entry.path, entry.authorEmail);
  }

  let addedPaths: string[];
  if (change.from === null) {
    addedPaths = await repo.addedSince(null, change.to, pathspec);
  } else {
    const changes = await repo.diff(change.from, change.to, pathspec);
    addedPaths = [];
    for (const c of changes) {
      if (!isMessagePath(c.path)) continue;
      if (c.status === "added") addedPaths.push(c.path);
      else update.anomalies.push({ path: c.path, status: c.status });
    }
  }

  for (const path of addedPaths.filter(isMessagePath).sort()) {
    const raw = await repo.readFile(change.to, path);
    if (raw === null) {
      update.unreadable.push({ path, error: new Error("blob missing from object store") });
      continue;
    }
    try {
      const message = parseMessage(raw, path);
      update.messages.push(message);
      const author = authorByPath.get(path);
      if (author !== undefined) update.commitAuthors.set(message.header.id, author);
    } catch (error) {
      // One malformed message must not block delivery of the rest.
      update.unreadable.push({ path, error });
    }
  }

  return update;
}
