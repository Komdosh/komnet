/**
 * The local inbox: what was addressed to this agent, and what it has looked at.
 *
 * Shares a section with the outbox in `network.ts` and shares nothing else with
 * it — this touches the state database and no git at all.
 */

import type { InboxItem, InboxQuery, StateDb } from "../state.ts";

/** What the inbox needs from the network, and nothing more. */
export interface InboxContext {
  readonly state: StateDb;
  assertSubscribed(roomId: string, verb: string): void;
}

/**
 * Remember what this agent has actually looked at, per room.
 *
 * Read receipts used to be derived from *drained* items, which made "read" mean
 * "processed and finished with" — so a peer asking "did they see it?" got "no"
 * about a message the agent had read and was still working on. Being returned
 * from the inbox is the moment it was read; completing it is a different fact,
 * and `processedAt` still carries that one.
 *
 * A high-water mark in `meta` rather than a column: ULIDs sort, so one string
 * per room answers it, and no schema bump discards anyone's history.
 */
export function recordSeen(ctx: InboxContext, items: readonly InboxItem[]): void {
  const highest = new Map<string, string>();
  for (const item of items) {
    const current = highest.get(item.room);
    if (current === undefined || item.id > current) highest.set(item.room, item.id);
  }
  for (const [room, id] of highest) {
    const key = `seenThrough:${room}`;
    const previous = ctx.state.getMeta(key);
    if (previous === null || id > previous) ctx.state.setMeta(key, id);
  }
}

export function inbox(ctx: InboxContext, query: InboxQuery = {}): InboxItem[] {
  if (query.room !== undefined) ctx.assertSubscribed(query.room, "read the inbox for");
  const items = ctx.state.listInbox(query);
  recordSeen(ctx, items);
  return items;
}

/**
 * Mark items processed. `needs: human` items are refused — only an answer
 * recorded through the human-relay path clears those.
 */
export function drainInbox(
  ctx: InboxContext,
  ids: readonly string[],
): { drained: number; refused: string[] } {
  const items = ctx.state.listInbox({ includeProcessed: true });
  const byId = new Map(items.map((i) => [i.id, i]));
  const refused = ids.filter((id) => byId.get(id)?.needs === "human");
  const drained = ctx.state.markProcessed(ids.filter((id) => !refused.includes(id)));
  return { drained, refused };
}
