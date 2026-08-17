/**
 * Delegated repository reviews, as the network performs them.
 *
 * The lifecycle rules are in `@komnet/protocol` and the reduction in
 * `../review/tasks.ts`; this is the part that reads a room, decides who to
 * address, and writes the transition.
 */

import {
  assertReviewTransition,
  createReviewTask,
  ulid,
  type Message,
  type Needs,
  type ReviewTask,
  type ReviewTaskState,
} from "@komnet/protocol";

import { reduceReviewTasks, type ReviewTaskStatus } from "../review/tasks.ts";
import type { ApprovalKind } from "../approvals.ts";
import type { ReviewRequestInput, ReviewUpdateInput, SendInput } from "../network.ts";

/** What review orchestration needs from the network, and nothing more. */
export interface ReviewsContext {
  readonly agentId: string;
  send(roomId: string, input: SendInput): Promise<Message>;
  read(roomId: string): Promise<Message[]>;
  requireApproval(kind: ApprovalKind, roomId: string, id: string, requester: string): Promise<void>;
}

/** Who must act next, derived from the state rather than declared by the author. */
function reviewNeeds(state: ReviewTaskState): Needs {
  if (state === "needs_human") return "human";
  if (
    state === "requested" ||
    state === "reported" ||
    state === "discussing" ||
    state === "blocked"
  )
    return "agent";
  return "none";
}

/** Who a transition should address, given who wrote it. */
function reviewMentions(review: ReviewTask, author: string): string[] {
  switch (review.state) {
    case "requested":
      return [review.reviewer];
    case "discussing":
      return [author === review.requester ? review.reviewer : review.requester];
    case "reported":
    case "blocked":
    case "needs_human":
      return [review.requester];
    case "cancelled":
    case "expired":
      return [review.reviewer];
    case "claimed":
    case "reviewing":
      return [];
    case "completed":
      return [review.reviewer];
  }
}

/** Create a targeted agent-to-agent repository review task. */
export async function requestReview(
  ctx: ReviewsContext,
  roomId: string,
  input: ReviewRequestInput,
): Promise<Message> {
  const review = createReviewTask({
    id: ulid(),
    requester: ctx.agentId,
    reviewer: input.reviewer,
    repo: input.repo,
    baseRev: input.baseRev,
    headRev: input.headRev,
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
  });
  return await ctx.send(roomId, {
    body: input.summary,
    kind: "question",
    needs: "agent",
    mentions: [input.reviewer],
    tags: ["review-task"],
    review,
  });
}

/** Current valid state of every review task in a room. */
export async function listReviewTasks(
  ctx: ReviewsContext,
  roomId: string,
): Promise<ReviewTaskStatus[]> {
  return reduceReviewTasks(await ctx.read(roomId));
}

/** Append one guarded state transition to an existing review task. */
export async function updateReview(
  ctx: ReviewsContext,
  roomId: string,
  reviewId: string,
  input: ReviewUpdateInput,
): Promise<Message> {
  const status = (await listReviewTasks(ctx, roomId)).find(
    (candidate) => candidate.review.id === reviewId,
  );
  if (status === undefined) throw new Error(`no review task ${reviewId} in room ${roomId}`);

  if (input.state === "claimed") {
    await ctx.requireApproval("review", roomId, reviewId, status.review.requester);
  }

  const review: ReviewTask = { ...status.review, state: input.state };
  assertReviewTransition(status.review, review, ctx.agentId);

  const mentions = reviewMentions(review, ctx.agentId);
  return await ctx.send(roomId, {
    body: input.body,
    ...(input.refs === undefined ? {} : { refs: input.refs }),
    kind: "status",
    needs: reviewNeeds(review.state),
    ...(mentions.length === 0 ? {} : { mentions }),
    tags: ["review-task", `review-state:${review.state}`],
    inReplyTo: status.currentMessageId,
    thread: status.thread,
    review,
  });
}
