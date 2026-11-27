import type { InboxItem, InboxQuery, StateDb } from "../state.ts";

export interface InboxContext {
  readonly state: StateDb;
  assertSubscribed(roomId: string, verb: string): void;
}

export function inbox(ctx: InboxContext, query: InboxQuery = {}, preview = false): InboxItem[] {
  if (query.room !== undefined) ctx.assertSubscribed(query.room, "read the inbox for");
  const items = ctx.state.listInbox(query);
  if (!preview) ctx.state.recordInboxViews(items.map((item) => item.id));
  return items;
}
