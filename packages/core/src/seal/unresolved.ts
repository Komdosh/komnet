import { isTerminalReviewTaskState, isTerminalTaskState, type Message } from "@komnet/protocol";

import { reduceReviewTasks } from "../review/tasks.ts";
import { reduceTasks } from "../task/tasks.ts";

function chronological(messages: readonly Message[]): Message[] {
  return [...messages].sort((a, b) => {
    const byTime = Date.parse(a.header.ts) - Date.parse(b.header.ts);
    if (byTime !== 0) return byTime;
    return a.header.id < b.header.id ? -1 : a.header.id > b.header.id ? 1 : 0;
  });
}

/**
 * Items whose raw chain must remain in the live window.
 *
 * Generic messages use question/answer semantics. Review and collaborative
 * tasks use their explicit lifecycles instead: the current event is unresolved
 * until a terminal state, even when an administrative event carries
 * `needs: none`.
 */
export function unresolvedMessages(messages: readonly Message[]): Message[] {
  const reviewStatuses = reduceReviewTasks(messages);
  const taskStatuses = reduceTasks(messages);
  const recognizedReviewIds = new Set(reviewStatuses.map((status) => status.review.id));
  const recognizedTaskIds = new Set(taskStatuses.map((status) => status.task.id));
  const answered = new Set(
    messages
      .filter(
        (message) => message.header.kind === "answer" && message.header.inReplyTo !== undefined,
      )
      .map((message) => message.header.inReplyTo as string),
  );
  const generic = messages.filter(
    (message) =>
      (message.header.review === undefined || !recognizedReviewIds.has(message.header.review.id)) &&
      (message.header.task === undefined || !recognizedTaskIds.has(message.header.task.id)) &&
      message.header.needs !== "none" &&
      !answered.has(message.header.id),
  );

  const byId = new Map(messages.map((message) => [message.header.id, message]));
  const activeReviews = reviewStatuses.flatMap((status) => {
    if (isTerminalReviewTaskState(status.review.state)) return [];
    const current = byId.get(status.currentMessageId);
    return current === undefined ? [] : [current];
  });

  const activeTasks = taskStatuses.flatMap((status) => {
    if (isTerminalTaskState(status.task.state)) return [];
    const current = byId.get(status.currentMessageId);
    return current === undefined ? [] : [current];
  });

  return chronological([...generic, ...activeReviews, ...activeTasks]);
}
