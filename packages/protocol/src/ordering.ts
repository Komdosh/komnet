import { compareUlid } from "./ids.ts";
import type { Message, MessageHeader } from "./message.ts";

/**
 * Order two messages (spec §13).
 *
 * Wall-clock `ts` is deliberately NOT the primary key: machine clocks disagree,
 * and a laptop resuming from sleep can emit a timestamp behind a peer's. ULIDs
 * carry the same time information but break ties deterministically, so every
 * participant sorts a room identically. True causality is carried by
 * `in_reply_to`, which `threadOrder` applies on top of this.
 */
export function compareMessages(a: MessageHeader, b: MessageHeader): number {
  return compareUlid(a.id, b.id);
}

/**
 * Arrange messages so every reply follows its parent, preserving chronological
 * order among siblings.
 *
 * Messages whose parent is absent (not yet fetched, or pruned from the window)
 * are treated as roots rather than dropped — a partial view must still render.
 */
export function threadOrder(messages: readonly Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const m of messages) byId.set(m.header.id, m);

  const children = new Map<string, Message[]>();
  const roots: Message[] = [];

  for (const m of messages) {
    const parent = m.header.inReplyTo;
    if (parent !== undefined && byId.has(parent)) {
      const bucket = children.get(parent);
      if (bucket === undefined) children.set(parent, [m]);
      else bucket.push(m);
    } else {
      roots.push(m);
    }
  }

  for (const bucket of children.values()) {
    bucket.sort((x, y) => compareMessages(x.header, y.header));
  }
  roots.sort((x, y) => compareMessages(x.header, y.header));

  // Iterative walk: a deep thread would otherwise risk a stack overflow, and
  // thread depth is attacker-influenced (anyone can keep replying).
  const out: Message[] = [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop() as Message;
    out.push(node);
    const kids = children.get(node.header.id);
    if (kids !== undefined) {
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as Message);
    }
  }
  return out;
}

/** Group messages by thread root, each group in thread order. */
export function groupByThread(messages: readonly Message[]): Map<string, Message[]> {
  const groups = new Map<string, Message[]>();
  for (const m of messages) {
    const bucket = groups.get(m.header.thread);
    if (bucket === undefined) groups.set(m.header.thread, [m]);
    else bucket.push(m);
  }
  for (const [key, bucket] of groups) groups.set(key, threadOrder(bucket));
  return groups;
}
