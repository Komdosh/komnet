import {
  assertInitialReviewTask,
  assertReviewTransition,
  compareMessages,
  isThreadRoot,
  type Message,
  type ReviewTask,
} from "@komnet/protocol";

export interface InvalidReviewEvent {
  messageId: string;
  reason: string;
}

export interface ReviewTaskStatus {
  review: ReviewTask;
  rootMessageId: string;
  currentMessageId: string;
  thread: string;
  updatedAt: string;
  invalidEvents: InvalidReviewEvent[];
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertInitialEvent(message: Message): ReviewTask {
  const review = message.header.review as ReviewTask;
  assertInitialReviewTask(review, message.header.from);
  if (!isThreadRoot(message.header)) {
    throw new Error("the initial review event must be a thread root");
  }
  if (message.header.kind !== "question" || message.header.needs !== "agent") {
    throw new Error("the initial review event must be a question with needs: agent");
  }
  if (!message.header.mentions.includes(review.reviewer)) {
    throw new Error("the initial review event must mention its declared reviewer");
  }
  return review;
}

function assertTransitionEvent(message: Message, review: ReviewTask): void {
  if (message.header.kind !== "status") {
    throw new Error("review lifecycle transitions must be status messages");
  }
  const expectedNeeds =
    review.state === "needs_human"
      ? "human"
      : review.state === "requested" ||
          review.state === "reported" ||
          review.state === "discussing" ||
          review.state === "blocked"
        ? "agent"
        : "none";
  if (message.header.needs !== expectedNeeds) {
    throw new Error(`review state '${review.state}' must carry needs: ${expectedNeeds}`);
  }
}

/**
 * Derive authoritative review state from append-only events in a room.
 *
 * A valid task is one linear reply chain. Concurrent siblings are retained in
 * git but only the first valid transition in ULID order advances state; the
 * losing sibling is reported as invalid instead of silently creating two
 * current states.
 */
export function reduceReviewTasks(messages: readonly Message[]): ReviewTaskStatus[] {
  const byTask = new Map<string, Message[]>();
  for (const message of messages) {
    const review = message.header.review;
    if (review === undefined) continue;
    const bucket = byTask.get(review.id);
    if (bucket === undefined) byTask.set(review.id, [message]);
    else bucket.push(message);
  }

  const statuses: ReviewTaskStatus[] = [];
  for (const events of byTask.values()) {
    events.sort((a, b) => compareMessages(a.header, b.header));
    const invalidEvents: InvalidReviewEvent[] = [];
    let root: Message | undefined;
    let rootIndex = -1;

    for (const [index, event] of events.entries()) {
      try {
        assertInitialEvent(event);
        root = event;
        rootIndex = index;
        break;
      } catch (error) {
        invalidEvents.push({ messageId: event.header.id, reason: reason(error) });
      }
    }
    if (root === undefined) {
      // With no trustworthy initial coordinates, later events cannot be
      // interpreted safely. The raw messages remain visible through read/history.
      continue;
    }

    let current = root;
    for (const event of events.slice(rootIndex + 1)) {
      const next = event.header.review as ReviewTask;
      try {
        if (event.header.thread !== root.header.thread) {
          throw new Error("review events must stay in the task's root thread");
        }
        if (event.header.inReplyTo !== current.header.id) {
          throw new Error("review events must form one linear reply chain");
        }
        assertTransitionEvent(event, next);
        assertReviewTransition(current.header.review as ReviewTask, next, event.header.from);
        current = event;
      } catch (error) {
        invalidEvents.push({ messageId: event.header.id, reason: reason(error) });
      }
    }

    statuses.push({
      review: current.header.review as ReviewTask,
      rootMessageId: root.header.id,
      currentMessageId: current.header.id,
      thread: root.header.thread,
      updatedAt: current.header.ts,
      invalidEvents,
    });
  }

  return statuses.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
