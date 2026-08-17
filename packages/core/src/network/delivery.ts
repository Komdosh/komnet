/**
 * Evidence that a message arrived, and what happened to it.
 *
 * Read receipts and `trace` belong together because trace is built from them:
 * one records what this agent has read, the other assembles what every
 * recipient did with one message.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  MAIN_REF,
  MENTION_ROOM,
  messagePath,
  receiptPath,
  roomDir,
  roomRef,
  type Message,
} from "@komnet/protocol";

import { FileLock } from "../lock.ts";
import { RoomStore } from "../room/store.ts";
import { exists } from "../fs.ts";
import { parseReadReceipt, serializeReadReceipt, type ReadReceipt } from "../agent/receipt.ts";
import type { AgentCard } from "../agent/card.ts";
import type { Layout } from "../layout.ts";
import type { MessageTrace, TraceRecipient } from "../network.ts";
import type { Repo } from "../git/repo.ts";
import type { StateDb } from "../state.ts";

const REMOTE = "origin";

/** What delivery evidence needs from the network. */
export interface DeliveryContext {
  readonly networkId: string;
  readonly agentId: string;
  readonly layout: Layout;
  readonly repo: Repo;
  readonly state: StateDb;
  /** Read live: a long-lived process picks up joins and leaves. */
  readonly subscriptions: readonly string[];
  readonly recordWorktree: string;
  readonly lockPath: string;
  listAgents(): Promise<AgentCard[]>;
  read(roomId: string, options?: { thread?: string; limit?: number }): Promise<Message[]>;
}

export async function publishReceipt(ctx: DeliveryContext, roomId: string): Promise<boolean> {
  // What this agent has READ, not what it has finished. See `recordSeen`.
  const readThrough = ctx.state.getMeta(`seenThrough:${roomId}`);
  if (readThrough === null || readThrough === "") return false;
  const seen = ctx.state
    .listInbox({ room: roomId, includeProcessed: true })
    .filter((item) => item.id <= readThrough);

  return await FileLock.withLock(ctx.lockPath, async () => {
    const path = receiptPath(roomId, ctx.agentId);
    const absolute = join(ctx.recordWorktree, path);
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

    await ctx.repo.commitFile(
      ctx.recordWorktree,
      path,
      serializeReadReceipt({
        v: 1,
        agent: ctx.agentId,
        room: roomId,
        readThrough,
        count: seen.length,
        updatedAt: new Date().toISOString(),
      }),
      `komnet: receipt ${ctx.agentId} ${roomId}`,
    );
    await ctx.repo.pushWithRetry(ctx.recordWorktree, MAIN_REF, {
      remote: REMOTE,
      maxAttempts: 3,
      backoffBaseMs: 100,
      backoffCapMs: 1_000,
    });
    return true;
  });
}

/** Every agent's read position in one room, newest first. */
export async function readReceipts(ctx: DeliveryContext, roomId: string): Promise<ReadReceipt[]> {
  const dir = join(ctx.recordWorktree, roomDir(roomId), "receipts");
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

/** Locate a message this agent can see, by id, across the rooms it follows. */
async function findSentMessage(
  ctx: DeliveryContext,
  messageId: string,
): Promise<{ message: Message; roomId: string } | null> {
  for (const roomId of ctx.subscriptions) {
    const worktree = ctx.layout.roomWorktree(ctx.networkId, roomId);
    if (!(await exists(worktree))) continue;
    const store = new RoomStore(worktree, roomId);
    const messages = await store.readAll(() => undefined);
    const message = messages.find((candidate) => candidate.header.id === messageId);
    if (message !== undefined) return { message, roomId };
  }
  return null;
}

/**
 * What actually happened to one message, per recipient.
 *
 * "Sent" was the only answer komnet could give, and it means the narrowest
 * possible thing: this machine wrote a commit. Everything a sender actually
 * wants to know — did it reach the remote, is that agent even in this room,
 * have they read it, have they answered — was spread across `outbox`, `agents`,
 * `receipts` and reading the thread, so in practice nobody assembled it and a
 * message sitting unread looked identical to one being ignored.
 *
 * Every state here is **derived from git**, and each is honest about its own
 * limits rather than upgrading a weaker signal into a stronger one:
 *
 * - `stored` / `pushed` — a local commit, then the remote's copy of the room
 *   branch containing this exact path. Ours to know for certain.
 * - `routable` — their published card lists this room. Reliable in the negative
 *   (ADR 0021): if it is missing, routing will not deliver.
 * - `read` — their own read receipt covers this id. It says an agent processed
 *   its inbox past this point, never that a model understood it.
 * - `answered` — a later message from them in the same thread. The strongest
 *   available evidence, and still not proof they agreed.
 *
 * There is deliberately no `session-activated` state. komnet never starts an
 * agent (ADR 0006), so nothing here can report one waking up; what it can say is
 * whether the other machine has a daemon publishing presence at all, which is
 * the difference between "will see this shortly" and "will see it when a person
 * next opens their editor".
 */
export async function trace(ctx: DeliveryContext, messageId: string): Promise<MessageTrace | null> {
  const found = await findSentMessage(ctx, messageId);
  if (found === null) return null;
  const { message, roomId } = found;
  const path = messagePath(message.header);
  const remoteRef = `refs/remotes/${REMOTE}/${roomRef(roomId)}`;
  const pushed = (await ctx.repo.readFile(remoteRef, path)) !== null;

  const cards = new Map((await ctx.listAgents()).map((card) => [card.id, card]));
  const receipts = new Map(
    (await readReceipts(ctx, roomId)).map((receipt) => [receipt.agent, receipt]),
  );
  // The whole thread, so "answered" means a reply that came AFTER this one.
  const thread = await ctx.read(roomId, { thread: message.header.thread, limit: 500 });

  const addressed = message.header.mentions.includes(MENTION_ROOM)
    ? [...cards.values()]
        .filter((card) => card.id !== ctx.agentId)
        .filter((card) => card.subscriptions?.includes(roomId) ?? true)
        .map((card) => card.id)
    : message.header.mentions.filter((agent) => agent !== ctx.agentId);

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
