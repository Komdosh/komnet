/**
 * A bounded block on the inbox.
 *
 * Its own module because it shares nothing with the domains it sits beside in
 * `network.ts`: it reads the inbox, drives sync, and watches a clock.
 */

import { clampWaitMs } from "../network.ts";
import type { InboxItem, InboxQuery } from "../state.ts";
import type { WaitForInboxOptions, WaitForInboxResult } from "../network.ts";

/** What waiting needs from the network, and nothing more. */
export interface WaitingContext {
  inbox(query: InboxQuery): InboxItem[];
  sync(): Promise<unknown>;
}

/**
 * Block until something matching lands in the inbox, or the bound expires.
 *
 * An agent turn cannot spin, so without this the only options were to poll
 * across turns or hand back to a human. The timeout is CAPPED rather than
 * honoured verbatim: callers reach this over MCP, whose clients enforce their
 * own request timeouts, so a tool that blocks for an hour gets killed by the
 * transport rather than answered. A bounded wait that says "nothing yet, ask
 * again" is honest; an unbounded one is a worse lie than polling.
 */
export async function waitForInbox(
  ctx: WaitingContext,
  options: WaitForInboxOptions = {},
): Promise<WaitForInboxResult> {
  const timeoutMs = clampWaitMs(options.timeoutMs);
  const pollMs = Math.min(Math.max(options.pollMs ?? 3_000, 500), timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const query: InboxQuery = {
    ...(options.room === undefined ? {} : { room: options.room }),
    ...(options.needs === undefined ? {} : { needs: options.needs }),
    ...(options.tag === undefined ? {} : { tag: options.tag }),
  };
  const matches = (): InboxItem[] => {
    const items = ctx.inbox(query);
    return options.thread === undefined
      ? items
      : items.filter((item) => item.thread === options.thread);
  };

  for (;;) {
    const found = matches();
    if (found.length > 0) return { items: found, timedOut: false, waitedMs: 0 };
    if (Date.now() >= deadline) return { items: [], timedOut: true, waitedMs: timeoutMs };

    try {
      await ctx.sync();
    } catch {
      // A transient sync failure must not end the wait early; the deadline does.
    }
    const after = matches();
    if (after.length > 0) {
      return { items: after, timedOut: false, waitedMs: timeoutMs - (deadline - Date.now()) };
    }
    if (Date.now() >= deadline) return { items: [], timedOut: true, waitedMs: timeoutMs };
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
  }
}
