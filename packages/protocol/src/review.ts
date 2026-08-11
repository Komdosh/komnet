import { MalformedMessageError, ProtocolError } from "./errors.ts";
import { isUlid } from "./ids.ts";
import { isAgentId } from "./identifiers.ts";

export const REVIEW_TASK_STATES = [
  "requested",
  "claimed",
  "reviewing",
  "reported",
  "discussing",
  "needs_human",
  "completed",
  "blocked",
  "expired",
  "cancelled",
] as const;

export type ReviewTaskState = (typeof REVIEW_TASK_STATES)[number];

export const TERMINAL_REVIEW_TASK_STATES = ["completed", "expired", "cancelled"] as const;

export interface ReviewTask {
  /** Stable ULID shared by every event in this review lifecycle. */
  id: string;
  state: ReviewTaskState;
  requester: string;
  reviewer: string;
  /** Canonical repository id, for example `github.com/acme/payments`; never a local path. */
  repo: string;
  /** Full immutable git object ids. */
  baseRev: string;
  headRev: string;
  /** Repository-relative paths. Empty means the whole repository. */
  scope: string[];
  /** RFC 3339 deadline. Expiry is an explicit event, never a silent local inference. */
  deadline?: string;
}

export interface NewReviewTaskInput {
  id: string;
  requester: string;
  reviewer: string;
  repo: string;
  baseRev: string;
  headRev: string;
  scope?: string[];
  deadline?: string;
}

export class ReviewTransitionError extends ProtocolError {
  constructor(message: string) {
    super("INVALID_REVIEW_TRANSITION", message);
    this.name = "ReviewTransitionError";
  }
}

export const REVIEW_WIRE_KEYS = [
  "review_id",
  "review_state",
  "review_requester",
  "review_reviewer",
  "review_repo",
  "review_base_rev",
  "review_head_rev",
  "review_scope",
  "review_deadline",
] as const;

const REVIEW_WIRE_KEY_SET = new Set<string>(REVIEW_WIRE_KEYS);
const FULL_GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const CANONICAL_REPO = /^[A-Za-z0-9][A-Za-z0-9.-]*\/[A-Za-z0-9._/-]+$/;

export function isCanonicalRepositoryId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_REPO.test(value) && !value.includes("..");
}

export function assertCanonicalRepositoryId(value: string): string {
  if (!isCanonicalRepositoryId(value)) {
    throw new TypeError(
      "repository id must be canonical host/owner/repository, for example github.com/acme/payments",
    );
  }
  return value;
}

const ALLOWED_TRANSITIONS: Record<ReviewTaskState, readonly ReviewTaskState[]> = {
  requested: [
    "claimed",
    "reviewing",
    "reported",
    "discussing",
    "needs_human",
    "blocked",
    "expired",
    "cancelled",
  ],
  claimed: [
    "reviewing",
    "reported",
    "discussing",
    "needs_human",
    "blocked",
    "expired",
    "cancelled",
  ],
  reviewing: ["reported", "discussing", "needs_human", "blocked", "expired", "cancelled"],
  reported: ["discussing", "needs_human", "completed", "expired", "cancelled"],
  discussing: [
    "discussing",
    "reported",
    "needs_human",
    "completed",
    "blocked",
    "expired",
    "cancelled",
  ],
  needs_human: ["discussing", "completed", "expired", "cancelled"],
  blocked: ["requested", "expired", "cancelled"],
  completed: [],
  expired: [],
  cancelled: [],
};

const REQUESTER_STATES = new Set<ReviewTaskState>([
  "requested",
  "completed",
  "expired",
  "cancelled",
]);
const REVIEWER_STATES = new Set<ReviewTaskState>(["claimed", "reviewing", "reported", "blocked"]);

function requiredString(
  raw: Record<string, unknown>,
  key: string,
  source: string | undefined,
): string {
  const value = raw[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new MalformedMessageError(`header field ${key} must be a non-empty string`, source);
  }
  return value;
}

function validateRepository(repo: string, source?: string): void {
  if (!isCanonicalRepositoryId(repo)) {
    throw new MalformedMessageError(
      "header field review_repo must be a canonical repository id such as github.com/acme/payments",
      source,
    );
  }
}

function validateRevision(value: string, key: string, source?: string): void {
  if (!FULL_GIT_OBJECT_ID.test(value)) {
    throw new MalformedMessageError(
      `header field ${key} must be a full 40- or 64-character git object id`,
      source,
    );
  }
}

function validateScope(scope: readonly string[], source?: string): void {
  for (const path of scope) {
    if (
      path.length === 0 ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").includes("..")
    ) {
      throw new MalformedMessageError(
        "header field review_scope must contain non-empty repository-relative paths",
        source,
      );
    }
  }
}

function validateDeadline(deadline: string, source?: string): void {
  if (!deadline.endsWith("Z") || Number.isNaN(Date.parse(deadline))) {
    throw new MalformedMessageError(
      "header field review_deadline must be an RFC 3339 UTC timestamp",
      source,
    );
  }
}

export function isReviewTaskState(value: unknown): value is ReviewTaskState {
  return typeof value === "string" && (REVIEW_TASK_STATES as readonly string[]).includes(value);
}

export function isTerminalReviewTaskState(state: ReviewTaskState): boolean {
  return (TERMINAL_REVIEW_TASK_STATES as readonly string[]).includes(state);
}

export function createReviewTask(input: NewReviewTaskInput): ReviewTask {
  const raw: Record<string, unknown> = {
    review_id: input.id,
    review_state: "requested",
    review_requester: input.requester,
    review_reviewer: input.reviewer,
    review_repo: input.repo,
    review_base_rev: input.baseRev,
    review_head_rev: input.headRev,
    review_scope: input.scope ?? [],
    ...(input.deadline === undefined ? {} : { review_deadline: input.deadline }),
  };
  return parseReviewTask(raw) as ReviewTask;
}

/** Parse the additive flat review fields from a message header. */
export function parseReviewTask(
  raw: Record<string, unknown>,
  source?: string,
): ReviewTask | undefined {
  const present = REVIEW_WIRE_KEYS.filter((key) => raw[key] !== undefined && raw[key] !== null);
  if (present.length === 0) return undefined;

  const id = requiredString(raw, "review_id", source);
  if (!isUlid(id)) {
    throw new MalformedMessageError(`header field review_id is not a ULID: ${id}`, source);
  }

  const state = raw["review_state"];
  if (!isReviewTaskState(state)) {
    throw new MalformedMessageError(
      `header field review_state must be one of: ${REVIEW_TASK_STATES.join(", ")}`,
      source,
    );
  }

  const requester = requiredString(raw, "review_requester", source);
  const reviewer = requiredString(raw, "review_reviewer", source);
  if (!isAgentId(requester) || !isAgentId(reviewer)) {
    throw new MalformedMessageError(
      "header fields review_requester and review_reviewer must be valid agent ids",
      source,
    );
  }
  if (requester === reviewer) {
    throw new MalformedMessageError(
      "review_requester and review_reviewer must identify different agents",
      source,
    );
  }

  const repo = requiredString(raw, "review_repo", source);
  validateRepository(repo, source);
  const baseRev = requiredString(raw, "review_base_rev", source);
  const headRev = requiredString(raw, "review_head_rev", source);
  validateRevision(baseRev, "review_base_rev", source);
  validateRevision(headRev, "review_head_rev", source);

  const rawScope = raw["review_scope"];
  const scope = rawScope === undefined || rawScope === null ? [] : rawScope;
  if (!Array.isArray(scope) || !scope.every((path) => typeof path === "string")) {
    throw new MalformedMessageError(
      "header field review_scope must be an array of strings",
      source,
    );
  }
  validateScope(scope, source);

  const rawDeadline = raw["review_deadline"];
  if (rawDeadline !== undefined && rawDeadline !== null && typeof rawDeadline !== "string") {
    throw new MalformedMessageError("header field review_deadline must be a string", source);
  }
  if (typeof rawDeadline === "string") validateDeadline(rawDeadline, source);

  return {
    id,
    state,
    requester,
    reviewer,
    repo,
    baseRev: baseRev.toLowerCase(),
    headRev: headRev.toLowerCase(),
    scope: [...scope],
    ...(typeof rawDeadline === "string" ? { deadline: rawDeadline } : {}),
  };
}

export function reviewTaskToWire(review: ReviewTask): Record<string, unknown> {
  return {
    review_id: review.id,
    review_state: review.state,
    review_requester: review.requester,
    review_reviewer: review.reviewer,
    review_repo: review.repo,
    review_base_rev: review.baseRev,
    review_head_rev: review.headRev,
    ...(review.scope.length === 0 ? {} : { review_scope: review.scope }),
    ...(review.deadline === undefined ? {} : { review_deadline: review.deadline }),
  };
}

export function isReviewWireKey(key: string): boolean {
  return REVIEW_WIRE_KEY_SET.has(key);
}

function sameCoordinates(a: ReviewTask, b: ReviewTask): boolean {
  return (
    a.id === b.id &&
    a.requester === b.requester &&
    a.reviewer === b.reviewer &&
    a.repo === b.repo &&
    a.baseRev === b.baseRev &&
    a.headRev === b.headRev &&
    a.deadline === b.deadline &&
    a.scope.length === b.scope.length &&
    a.scope.every((path, index) => path === b.scope[index])
  );
}

/** Validate the first event of a review task. */
export function assertInitialReviewTask(review: ReviewTask, author: string): void {
  if (review.state !== "requested") {
    throw new ReviewTransitionError("the first review event must have state 'requested'");
  }
  if (author !== review.requester) {
    throw new ReviewTransitionError("only the declared requester can create a review task");
  }
}

/** Validate one append-only lifecycle transition and its producing agent. */
export function assertReviewTransition(
  previous: ReviewTask,
  next: ReviewTask,
  author: string,
): void {
  if (!sameCoordinates(previous, next)) {
    throw new ReviewTransitionError(
      "review repository, revisions, scope, participants, and deadline are immutable",
    );
  }
  if (!ALLOWED_TRANSITIONS[previous.state].includes(next.state)) {
    throw new ReviewTransitionError(
      `review state cannot move from '${previous.state}' to '${next.state}'`,
    );
  }

  const expected = REQUESTER_STATES.has(next.state)
    ? previous.requester
    : REVIEWER_STATES.has(next.state)
      ? previous.reviewer
      : null;
  if (expected !== null && author !== expected) {
    throw new ReviewTransitionError(
      `only review ${expected === previous.requester ? "requester" : "reviewer"} ${expected} may set state '${next.state}'`,
    );
  }
  if (expected === null && author !== previous.requester && author !== previous.reviewer) {
    throw new ReviewTransitionError(`only review participants may set state '${next.state}'`);
  }
}
