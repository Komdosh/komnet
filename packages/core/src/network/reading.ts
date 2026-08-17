/**
 * Reading a room: the live window, the history behind it, and search across both.
 *
 * The three differ in what they are allowed to cost. `read` touches a
 * materialised worktree, `history` walks git, and `search` deliberately refuses
 * to walk git at all — the reasoning is on each function.
 */

import { isMessagePath, parseMessage, roomRef, threadOrder, type Message } from "@komnet/protocol";

import { exists } from "../fs.ts";
import { RoomStore } from "../room/store.ts";
import type { Layout } from "../layout.ts";
import type { Repo } from "../git/repo.ts";

/** What reading needs from the network, and nothing more. */
export interface ReadingContext {
  readonly networkId: string;
  readonly layout: Layout;
  readonly repo: Repo;
  /** Read live, not snapshotted: a long-lived process picks up joins and leaves. */
  readonly subscriptions: readonly string[];
  assertSubscribed(roomId: string, verb: string): void;
  ensureRoomWorktree(roomId: string): Promise<string>;
}

export async function read(
  ctx: ReadingContext,
  roomId: string,
  options: { limit?: number; thread?: string } = {},
): Promise<Message[]> {
  ctx.assertSubscribed(roomId, "read");
  const worktree = await ctx.ensureRoomWorktree(roomId);
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
 * Sealing removes old messages from the tree but never from history, so this is
 * what makes "pruning is not data loss" true in practice rather than only in
 * principle (docs/design/06-retention-and-sealing.md §1).
 */
export async function history(
  ctx: ReadingContext,
  roomId: string,
  options: { since?: string; limit?: number } = {},
): Promise<Message[]> {
  ctx.assertSubscribed(roomId, "read the history of");
  await ctx.ensureRoomWorktree(roomId);
  const ref = `refs/heads/${roomRef(roomId)}`;
  const entries = await ctx.repo.logAddedPaths(
    ref,
    `rooms/${roomId}/msg/`,
    options.since === undefined ? {} : { since: options.since },
  );

  const messages: Message[] = [];
  const seen = new Set<string>();
  for (const { commit, path } of entries) {
    if (!isMessagePath(path) || seen.has(path)) continue;
    seen.add(path);
    const raw = await ctx.repo.readFile(commit, path);
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
export async function search(
  ctx: ReadingContext,
  query: string,
  options: { room?: string; limit?: number } = {},
): Promise<{ room: string; message: Message }[]> {
  if (options.room !== undefined) ctx.assertSubscribed(options.room, "search");
  const needle = query.toLowerCase();
  const rooms = options.room === undefined ? ctx.subscriptions : [options.room];
  const hits: { room: string; message: Message }[] = [];

  for (const roomId of rooms) {
    const worktree = ctx.layout.roomWorktree(ctx.networkId, roomId);
    if (!(await exists(worktree))) continue;
    const messages = await new RoomStore(worktree, roomId).readAll(() => undefined);
    for (const message of messages) {
      if (message.body.toLowerCase().includes(needle)) hits.push({ room: roomId, message });
    }
  }
  hits.sort((a, b) => (a.message.header.id < b.message.header.id ? 1 : -1));
  return options.limit === undefined ? hits : hits.slice(0, options.limit);
}
