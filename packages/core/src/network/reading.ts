/**
 * Reading a room: the live window, the history behind it, and search across both.
 *
 * The three differ in what they are allowed to cost. `read` touches a
 * materialised worktree, `history` walks git, and `search` deliberately refuses
 * to walk git at all — the reasoning is on each function.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import {
  isMessagePath,
  parseMessage,
  roomDir,
  roomRef,
  splitFrontmatter,
  threadOrder,
  type Message,
} from "@komnet/protocol";

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
  /** Worktree of the record branch, where sealing promotes decisions. */
  readonly recordWorktree: string;
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

/**
 * One decision in a room's permanent record.
 *
 * `sealed` is the difference that matters: a sealed decision is a document on
 * the record branch that compaction will never prune, while an unsealed one is
 * still an ordinary message in the live window and would vanish with it if the
 * room were pruned before the next seal. Both are real decisions; only one is
 * durable yet.
 */
export interface RoomDecision {
  /** Record-branch sequence number, or null while the decision is still live. */
  readonly seq: number | null;
  readonly title: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
  /** Id of the message that recorded it, which is also its stable identity. */
  readonly sourceMessage: string;
  readonly supersedes: string | null;
  /** Set when a later decision replaced this one, so "current" is readable. */
  readonly supersededBy: string | null;
  readonly body: string;
  readonly sealed: boolean;
  /** Path on the record branch once sealed. */
  readonly path: string | null;
}

interface RawDecision {
  seq: number | null;
  title: string;
  decidedBy: string;
  decidedAt: string;
  sourceMessage: string;
  supersedes: string | null;
  body: string;
  sealed: boolean;
  path: string | null;
}

/**
 * Every decision a room has recorded, sealed and live, in one ordered answer.
 *
 * Decisions are the one thing sealing promises to keep (ADR-backed, see
 * docs/design/06-retention-and-sealing.md), and until this existed there was no
 * way to read that promise back: `read` stops at the live window and `search`
 * never reaches the record branch, so a sealed decision was written and then
 * unreachable through any surface. Merging both sources is the point — asking
 * "what has this room decided" must not depend on when the room was last
 * compacted.
 */
export async function decisions(
  ctx: ReadingContext,
  roomId: string,
  options: { limit?: number; includeSuperseded?: boolean } = {},
): Promise<RoomDecision[]> {
  ctx.assertSubscribed(roomId, "read the decisions of");

  const sealed = await sealedDecisions(ctx, roomId);
  const promotedSources = new Set(sealed.map((d) => d.sourceMessage));

  // A decision stays in the live window until the room is sealed, so the same
  // decision can exist in both places at once. The record-branch copy wins:
  // it carries the sequence number and is the one that survives pruning.
  const live: RawDecision[] = [];
  const worktree = ctx.layout.roomWorktree(ctx.networkId, roomId);
  if (await exists(worktree)) {
    const messages = await new RoomStore(worktree, roomId).readAll(() => undefined);
    for (const message of messages) {
      if (message.header.kind !== "decision") continue;
      if (promotedSources.has(message.header.id)) continue;
      live.push({
        seq: null,
        title: firstLine(message.body),
        decidedBy: message.header.from,
        decidedAt: message.header.ts,
        sourceMessage: message.header.id,
        supersedes: message.header.inReplyTo ?? null,
        body: message.body,
        sealed: false,
        path: null,
      });
    }
  }

  const all = [...sealed, ...live].sort((a, b) =>
    a.decidedAt === b.decidedAt
      ? a.sourceMessage.localeCompare(b.sourceMessage)
      : a.decidedAt.localeCompare(b.decidedAt),
  );

  const supersededBy = new Map<string, string>();
  for (const decision of all) {
    if (decision.supersedes !== null) supersededBy.set(decision.supersedes, decision.sourceMessage);
  }

  let resolved: RoomDecision[] = all.map((decision) => ({
    ...decision,
    supersededBy: supersededBy.get(decision.sourceMessage) ?? null,
  }));
  if (options.includeSuperseded !== true) {
    resolved = resolved.filter((decision) => decision.supersededBy === null);
  }
  return options.limit === undefined ? resolved : resolved.slice(-options.limit);
}

/** Decision documents on the record branch: `rooms/<id>/decisions/<NNNN>-<slug>.md`. */
async function sealedDecisions(ctx: ReadingContext, roomId: string): Promise<RawDecision[]> {
  const dir = join(ctx.recordWorktree, roomDir(roomId), "decisions");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // No seal has run for this room yet, which is not an error — every
    // decision it has is still live.
    return [];
  }

  const found: RawDecision[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".md")) continue;
    const rel = `${roomDir(roomId)}/decisions/${name}`;
    let raw: string;
    try {
      raw = await readFile(join(dir, name), "utf8");
    } catch {
      continue;
    }
    const parsed = parseDecisionDocument(raw, rel);
    if (parsed !== null) found.push(parsed);
  }
  return found;
}

function parseDecisionDocument(raw: string, path: string): RawDecision | null {
  let split: { frontmatter: string; body: string };
  try {
    split = splitFrontmatter(raw, path);
  } catch {
    // One malformed decision document must not sink the whole query, exactly
    // as in `history`.
    return null;
  }
  let meta: unknown;
  try {
    meta = parseYaml(split.frontmatter);
  } catch {
    return null;
  }
  if (typeof meta !== "object" || meta === null) return null;
  const record = meta as Record<string, unknown>;
  const sourceMessage = record["source_message"];
  if (typeof sourceMessage !== "string") return null;

  const seq = record["seq"];
  const supersedes = record["supersedes"];
  return {
    seq: typeof seq === "number" ? seq : null,
    title: typeof record["title"] === "string" ? record["title"] : firstLine(split.body),
    decidedBy: typeof record["decided_by"] === "string" ? record["decided_by"] : "unknown",
    decidedAt: typeof record["decided_at"] === "string" ? record["decided_at"] : "",
    sourceMessage,
    supersedes: typeof supersedes === "string" && supersedes !== "null" ? supersedes : null,
    body: split.body.trim(),
    sealed: true,
    path,
  };
}

function firstLine(body: string): string {
  return (
    body
      .trim()
      .split("\n")[0]
      ?.replace(/^#+\s*/, "") ?? "decision"
  );
}
