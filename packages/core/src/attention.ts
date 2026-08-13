/**
 * Which pending messages are worth breaking off work for.
 *
 * An agent part-way through long work had no cheap way to ask "does anything
 * need me?". The only answer available was the inbox itself, and reading an
 * inbox is irreversible: once a teammate's question is in context the model
 * reprioritises around it whether or not it bore on the work in hand. The act
 * of checking was the interruption.
 *
 * So the check that runs mid-flight returns ids and reasons and nothing else,
 * and everything it did not select is a single number. A count cannot hijack
 * attention. Reading a body stays a deliberate second step, taken once
 * something has already earned it.
 */

/**
 * The fields a relevance decision needs — deliberately not the body.
 *
 * Structural, so this module stays pure and testable without the sqlite cache;
 * `InboxItem` satisfies it.
 */
export interface AttentionInput {
  id: string;
  room: string;
  from: string;
  needs: string;
  priority: string;
  thread: string;
}

export const INTERRUPT_REASONS = ["in-flight-thread", "needs-human", "blocking"] as const;
export type InterruptReason = (typeof INTERRUPT_REASONS)[number];

export interface AttentionItem extends AttentionInput {
  reason: InterruptReason;
}

export interface Attention {
  /** Pending items that bear on the work in hand, or that only a person can clear. */
  interrupting: AttentionItem[];
  /** How many pending items did not qualify. A number, never their contents. */
  deferred: number;
}

/**
 * Three signals justify an interruption, all decidable from the cached row:
 *
 * - `in-flight-thread` — a reply in the thread of a task this agent is actively
 *   moving. This is the work in hand answering back, so it is not a distraction
 *   from the work; it is the work.
 * - `needs-human` — only a person can clear it, that person is sitting here,
 *   and it is never drained, so it waits silently until someone says it aloud.
 * - `blocking` — the sender has said they cannot proceed.
 *
 * Everything else waits for a boundary the agent picks. Ranked most specific
 * first: a reply on the work in hand describes why to stop better than whatever
 * priority its author happened to set.
 */
function reasonFor(
  item: AttentionInput,
  inFlightThreads: ReadonlySet<string>,
): InterruptReason | null {
  if (inFlightThreads.has(item.thread)) return "in-flight-thread";
  if (item.needs === "human") return "needs-human";
  if (item.priority === "blocking") return "blocking";
  return null;
}

export function classifyAttention(
  items: readonly AttentionInput[],
  inFlightThreads: ReadonlySet<string>,
): Attention {
  const interrupting: AttentionItem[] = [];
  let deferred = 0;

  for (const item of items) {
    const reason = reasonFor(item, inFlightThreads);
    if (reason === null) {
      deferred += 1;
      continue;
    }
    // Field by field, never a spread. Callers pass inbox rows, which carry the
    // message body; copying one through here would defeat the entire point of
    // the call.
    interrupting.push({
      id: item.id,
      room: item.room,
      from: item.from,
      needs: item.needs,
      priority: item.priority,
      thread: item.thread,
      reason,
    });
  }

  return { interrupting, deferred };
}
