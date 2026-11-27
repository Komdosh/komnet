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
  machineFromToken,
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
import { shouldDeliverMessage } from "../sync/routing.ts";
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
}

export async function publishReceipt(ctx: DeliveryContext, roomId: string): Promise<boolean> {
  const viewed = ctx.state.viewedInboxIds(roomId);
  if (viewed.length === 0) return false;

  return await FileLock.withLock(ctx.lockPath, async () => {
    const path = receiptPath(roomId, ctx.agentId);
    const absolute = join(ctx.recordWorktree, path);
    let previous: ReadReceipt | undefined;
    if (await exists(absolute)) {
      try {
        previous = parseReadReceipt(await readFile(absolute, "utf8"));
      } catch {
        // Replacing our own malformed receipt is safer than preserving it.
      }
    }
    const published = new Set(previous?.readIds);
    if (viewed.every((id) => published.has(id))) return false;
    for (const id of viewed) published.add(id);
    const readIds = [...published].sort();
    const latestView = readIds.at(-1) ?? "";
    const previousProgress = previous?.readThrough ?? "";

    await ctx.repo.commitFile(
      ctx.recordWorktree,
      path,
      serializeReadReceipt({
        v: 1,
        agent: ctx.agentId,
        room: roomId,
        readThrough: latestView > previousProgress ? latestView : previousProgress,
        readIds,
        count: readIds.length,
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
async function findLiveMessage(
  ctx: DeliveryContext,
  messageId: string,
): Promise<{ message: Message; roomId: string; messages: Message[] } | null> {
  for (const roomId of ctx.subscriptions) {
    const worktree = ctx.layout.roomWorktree(ctx.networkId, roomId);
    if (!(await exists(worktree))) continue;
    const store = new RoomStore(worktree, roomId);
    const messages = await store.readAll(() => undefined);
    const message = messages.find((candidate) => candidate.header.id === messageId);
    if (message !== undefined) return { message, roomId, messages };
  }
  return null;
}

/** Transport, routing, exact inbox views, and direct replies for a live message. */
export async function trace(ctx: DeliveryContext, messageId: string): Promise<MessageTrace | null> {
  const found = await findLiveMessage(ctx, messageId);
  if (found === null) return null;
  const { message, roomId, messages } = found;
  const path = messagePath(message.header);
  const remoteRef = `refs/remotes/${REMOTE}/${roomRef(roomId)}`;
  const pushed = (await ctx.repo.readFile(remoteRef, path)) !== null;

  const cards = new Map((await ctx.listAgents()).map((card) => [card.id, card]));
  const receipts = new Map(
    (await readReceipts(ctx, roomId)).map((receipt) => [receipt.agent, receipt]),
  );
  const addressed = new Set(
    message.header.mentions.filter(
      (mention) =>
        mention !== message.header.from &&
        mention !== MENTION_ROOM &&
        machineFromToken(mention) === null,
    ),
  );
  const subscriptions = new Set([roomId]);
  for (const card of cards.values()) {
    if (card.subscriptions?.includes(roomId) === false) continue;
    if (shouldDeliverMessage(message, card.id, subscriptions, card.machine?.id)) {
      addressed.add(card.id);
    }
  }
  const repliers = new Set(
    messages
      .filter((other) => other.header.inReplyTo === message.header.id)
      .map((other) => other.header.from),
  );

  const recipients: TraceRecipient[] = [...addressed].sort().map((agent) => {
    const card = cards.get(agent);
    const receipt = receipts.get(agent);
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
      read: receipt?.readIds?.includes(message.header.id) ?? false,
      roomReadThrough: receipt?.readThrough ?? null,
      answered: repliers.has(agent),
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
