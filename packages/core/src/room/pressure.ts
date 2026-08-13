import { threadOrder, type Message } from "@komnet/protocol";

export interface ThreadPressure {
  /** Consecutive agent-authored messages since the most recent human relay. */
  consecutiveAgentMessages: number;
  /** The proposed agent message consumes the room's configured budget. */
  shouldPark: boolean;
}

/**
 * Bound autonomous back-and-forth without pretending this is enforcement.
 *
 * The shared git log remains open to any writer. This helper makes conforming
 * clients turn the last allowed agent reply into a cooperative
 * `needs: human` hand-off.
 *
 * A human-authored message **in the same thread** starts a fresh budget — see
 * the `authorKind === "human"` break below. That is the intended way to resume,
 * and it was never surfaced: agents that hit the limit opened a NEW thread
 * instead, splitting one piece of work across two and discarding the context
 * that made it worth reading. Every surface now says so at the moment it parks.
 */
export function assessThreadPressure(
  messages: readonly Message[],
  thread: string,
  replyBudget: number,
): ThreadPressure {
  return assessPressure(messages, thread, replyBudget, () => true);
}

/** Count only substantive back-and-forth for one review, not its administrative states. */
export function assessReviewDiscussionPressure(
  messages: readonly Message[],
  thread: string,
  reviewId: string,
  replyBudget: number,
): ThreadPressure {
  return assessPressure(
    messages,
    thread,
    replyBudget,
    (message) =>
      message.header.review?.id === reviewId && message.header.review.state === "discussing",
  );
}

function assessPressure(
  messages: readonly Message[],
  thread: string,
  replyBudget: number,
  counts: (message: Message) => boolean,
): ThreadPressure {
  const budget = Number.isFinite(replyBudget) ? Math.max(1, Math.floor(replyBudget)) : 1;
  const ordered = threadOrder(messages.filter((message) => message.header.thread === thread));

  let consecutiveAgentMessages = 0;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const message = ordered[index] as Message;
    if (message.header.authorKind === "human") break;
    if (counts(message)) consecutiveAgentMessages += 1;
  }

  return {
    consecutiveAgentMessages,
    shouldPark: consecutiveAgentMessages + 1 >= budget,
  };
}
