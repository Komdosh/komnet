import { MalformedMessageError, ProtocolError } from "./errors.ts";
import { isUlid } from "./ids.ts";
import { isAgentId } from "./identifiers.ts";

export const TASK_STATES = [
  "open",
  "claimed",
  "in_progress",
  "blocked",
  "stuck",
  "completed",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_ACTIONS = [
  "created",
  "refined",
  "retargeted",
  "claimed",
  "started",
  "progressed",
  "blocked",
  "stuck",
  "released",
  "completed",
  "cancelled",
  "reopened",
] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

export const TASK_UPDATE_ACTIONS = [
  "refined",
  "retargeted",
  "started",
  "progressed",
  "blocked",
  "stuck",
  "released",
  "completed",
  "cancelled",
  "reopened",
] as const;
export type TaskUpdateAction = (typeof TASK_UPDATE_ACTIONS)[number];

export const TERMINAL_TASK_STATES = ["completed", "cancelled"] as const;
export const DEFAULT_TASK_STALE_AFTER_SECONDS = 24 * 60 * 60;

/** Full task snapshot carried by every append-only lifecycle event. */
export interface Task {
  /** Stable ULID shared by every event in this task lifecycle. */
  id: string;
  state: TaskState;
  action: TaskAction;
  creator: string;
  title: string;
  /** Explicit target while open. Undefined means any room subscriber may claim it. */
  target?: string;
  /** Agent that accepted responsibility. Present after claim until release/reopen. */
  assignee?: string;
  /** A non-terminal task with no valid event for this many seconds is stale. */
  staleAfterSeconds: number;
}

export interface NewTaskInput {
  id: string;
  creator: string;
  title: string;
  target?: string;
  staleAfterSeconds?: number;
}

export class TaskTransitionError extends ProtocolError {
  constructor(message: string) {
    super("INVALID_TASK_TRANSITION", message);
    this.name = "TaskTransitionError";
  }
}

export const TASK_WIRE_KEYS = [
  "task_id",
  "task_state",
  "task_action",
  "task_creator",
  "task_title",
  "task_target",
  "task_assignee",
  "task_stale_after_seconds",
] as const;

const TASK_WIRE_KEY_SET = new Set<string>(TASK_WIRE_KEYS);
const MAX_TASK_STALE_AFTER_SECONDS = 365 * 24 * 60 * 60;

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

function optionalAgent(
  raw: Record<string, unknown>,
  key: string,
  source: string | undefined,
): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !isAgentId(value)) {
    throw new MalformedMessageError(`header field ${key} must be a valid agent id`, source);
  }
  return value;
}

function validateTitle(title: string, source?: string): void {
  if (title.trim().length === 0 || title.length > 200 || /[\r\n]/.test(title)) {
    throw new MalformedMessageError(
      "header field task_title must be one non-empty line of at most 200 characters",
      source,
    );
  }
}

function validateStaleAfter(value: unknown, source?: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 60 ||
    value > MAX_TASK_STALE_AFTER_SECONDS
  ) {
    throw new MalformedMessageError(
      `header field task_stale_after_seconds must be an integer from 60 to ${String(MAX_TASK_STALE_AFTER_SECONDS)}`,
      source,
    );
  }
  return value;
}

function assertResultShape(task: Task, source?: string): void {
  const expectedStates: Partial<Record<TaskAction, readonly TaskState[]>> = {
    created: ["open"],
    retargeted: ["open"],
    claimed: ["claimed"],
    started: ["in_progress"],
    progressed: ["in_progress"],
    blocked: ["blocked"],
    stuck: ["stuck"],
    released: ["open"],
    completed: ["completed"],
    cancelled: ["cancelled"],
    reopened: ["open"],
  };
  const allowed = expectedStates[task.action];
  if (allowed !== undefined && !allowed.includes(task.state)) {
    throw new MalformedMessageError(
      `task action '${task.action}' cannot produce state '${task.state}'`,
      source,
    );
  }

  const requiresAssignee = ["claimed", "in_progress", "blocked", "stuck", "completed"].includes(
    task.state,
  );
  const forbidsAssignee = task.state === "open";
  if (
    (requiresAssignee && task.assignee === undefined) ||
    (forbidsAssignee && task.assignee !== undefined)
  ) {
    throw new MalformedMessageError(
      `task state '${task.state}' ${requiresAssignee ? "requires" : "does not allow"} task_assignee`,
      source,
    );
  }
  if (task.target !== undefined && task.assignee !== undefined && task.target !== task.assignee) {
    throw new MalformedMessageError("task_assignee must match task_target", source);
  }
}

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === "string" && (TASK_STATES as readonly string[]).includes(value);
}

export function isTaskAction(value: unknown): value is TaskAction {
  return typeof value === "string" && (TASK_ACTIONS as readonly string[]).includes(value);
}

export function isTaskUpdateAction(value: unknown): value is TaskUpdateAction {
  return typeof value === "string" && (TASK_UPDATE_ACTIONS as readonly string[]).includes(value);
}

export function isTerminalTaskState(value: TaskState): boolean {
  return (TERMINAL_TASK_STATES as readonly TaskState[]).includes(value);
}

export function createTask(input: NewTaskInput): Task {
  const raw: Record<string, unknown> = {
    task_id: input.id,
    task_state: "open",
    task_action: "created",
    task_creator: input.creator,
    task_title: input.title,
    task_stale_after_seconds: input.staleAfterSeconds ?? DEFAULT_TASK_STALE_AFTER_SECONDS,
    ...(input.target === undefined ? {} : { task_target: input.target }),
  };
  return parseTask(raw) as Task;
}

export function parseTask(raw: Record<string, unknown>, source?: string): Task | undefined {
  const present = TASK_WIRE_KEYS.filter((key) => raw[key] !== undefined && raw[key] !== null);
  if (present.length === 0) return undefined;

  const id = requiredString(raw, "task_id", source);
  if (!isUlid(id)) {
    throw new MalformedMessageError(`header field task_id is not a ULID: ${id}`, source);
  }
  const state = raw["task_state"];
  if (!isTaskState(state)) {
    throw new MalformedMessageError(
      `header field task_state must be one of: ${TASK_STATES.join(", ")}`,
      source,
    );
  }
  const action = raw["task_action"];
  if (!isTaskAction(action)) {
    throw new MalformedMessageError(
      `header field task_action must be one of: ${TASK_ACTIONS.join(", ")}`,
      source,
    );
  }
  const creator = requiredString(raw, "task_creator", source);
  if (!isAgentId(creator)) {
    throw new MalformedMessageError("header field task_creator must be a valid agent id", source);
  }
  const title = requiredString(raw, "task_title", source);
  validateTitle(title, source);
  const target = optionalAgent(raw, "task_target", source);
  const assignee = optionalAgent(raw, "task_assignee", source);
  const staleAfterSeconds = validateStaleAfter(raw["task_stale_after_seconds"], source);

  const task: Task = {
    id,
    state,
    action,
    creator,
    title,
    staleAfterSeconds,
    ...(target === undefined ? {} : { target }),
    ...(assignee === undefined ? {} : { assignee }),
  };
  assertResultShape(task, source);
  return task;
}

export function taskToWire(task: Task): Record<string, unknown> {
  return {
    task_id: task.id,
    task_state: task.state,
    task_action: task.action,
    task_creator: task.creator,
    task_title: task.title,
    ...(task.target === undefined ? {} : { task_target: task.target }),
    ...(task.assignee === undefined ? {} : { task_assignee: task.assignee }),
    task_stale_after_seconds: task.staleAfterSeconds,
  };
}

export function isTaskWireKey(value: string): boolean {
  return TASK_WIRE_KEY_SET.has(value);
}

/** Validate the first append-only event of a task. */
export function assertInitialTask(task: Task, author: string): void {
  if (task.action !== "created" || task.state !== "open") {
    throw new TaskTransitionError("the first task event must be action 'created' in state 'open'");
  }
  if (task.assignee !== undefined) {
    throw new TaskTransitionError("a new task cannot already have an assignee");
  }
  if (author !== task.creator) {
    throw new TaskTransitionError("only the declared creator can create a task");
  }
}

function assertUnchanged(condition: boolean, message: string): void {
  if (!condition) throw new TaskTransitionError(message);
}

function sameIdentity(previous: Task, next: Task): boolean {
  return (
    previous.id === next.id &&
    previous.creator === next.creator &&
    previous.staleAfterSeconds === next.staleAfterSeconds
  );
}

function sameAssignment(previous: Task, next: Task): boolean {
  return previous.target === next.target && previous.assignee === next.assignee;
}

/** Validate one task event against the latest accepted task snapshot. */
export function assertTaskTransition(previous: Task, next: Task, author: string): void {
  assertUnchanged(
    sameIdentity(previous, next),
    "task id, creator, and stale threshold are immutable",
  );
  if (next.action !== "refined") {
    assertUnchanged(previous.title === next.title, "only a refinement may change the task title");
  }
  if (next.action !== "retargeted") {
    assertUnchanged(previous.target === next.target, "only the creator may retarget an open task");
  }

  switch (next.action) {
    case "created":
      throw new TaskTransitionError("a task can have only one creation event");
    case "refined":
      assertUnchanged(!isTerminalTaskState(previous.state), "a terminal task cannot be refined");
      assertUnchanged(previous.state === next.state, "a refinement cannot change task state");
      assertUnchanged(sameAssignment(previous, next), "a refinement cannot change assignment");
      return;
    case "retargeted":
      assertUnchanged(author === previous.creator, "only the task creator may retarget it");
      assertUnchanged(
        previous.state === "open" && next.state === "open",
        "only an open task can be retargeted",
      );
      assertUnchanged(
        previous.assignee === undefined && next.assignee === undefined,
        "a claimed task must be released before retargeting",
      );
      assertUnchanged(previous.target !== next.target, "retargeting must change the target");
      return;
    case "claimed":
      assertUnchanged(
        previous.state === "open" && next.state === "claimed",
        "only an open task can be claimed",
      );
      assertUnchanged(previous.assignee === undefined, "the task is already assigned");
      assertUnchanged(next.assignee === author, "an agent may claim a task only for itself");
      assertUnchanged(
        previous.target === undefined || previous.target === author,
        "this task is targeted to another agent",
      );
      return;
    case "started":
      assertUnchanged(
        ["claimed", "blocked", "stuck"].includes(previous.state) && next.state === "in_progress",
        "a task starts from claimed, blocked, or stuck",
      );
      break;
    case "progressed":
      assertUnchanged(
        previous.state === "in_progress" && next.state === "in_progress",
        "progress requires an in-progress task",
      );
      break;
    case "blocked":
      assertUnchanged(
        ["claimed", "in_progress"].includes(previous.state) && next.state === "blocked",
        "only a claimed or in-progress task can be blocked",
      );
      break;
    case "stuck":
      assertUnchanged(
        ["in_progress", "blocked"].includes(previous.state) && next.state === "stuck",
        "a task becomes stuck from in-progress or blocked",
      );
      break;
    case "released":
      assertUnchanged(
        ["claimed", "in_progress", "blocked", "stuck"].includes(previous.state) &&
          next.state === "open",
        "only an active task can be released back to open",
      );
      assertUnchanged(
        author === previous.assignee || author === previous.creator,
        "only the assignee or creator may release a task",
      );
      assertUnchanged(next.assignee === undefined, "a released task must clear its assignee");
      return;
    case "completed":
      assertUnchanged(
        previous.state === "in_progress" && next.state === "completed",
        "a task completes only from in-progress",
      );
      break;
    case "cancelled":
      assertUnchanged(!isTerminalTaskState(previous.state), "the task is already terminal");
      assertUnchanged(next.state === "cancelled", "cancelling must produce state 'cancelled'");
      assertUnchanged(author === previous.creator, "only the task creator may cancel it");
      assertUnchanged(sameAssignment(previous, next), "cancelling cannot change assignment");
      return;
    case "reopened":
      assertUnchanged(
        isTerminalTaskState(previous.state) && next.state === "open",
        "only a terminal task can be reopened",
      );
      assertUnchanged(author === previous.creator, "only the task creator may reopen it");
      assertUnchanged(next.assignee === undefined, "a reopened task must be claimed again");
      return;
  }

  assertUnchanged(
    sameAssignment(previous, next),
    `task action '${next.action}' cannot change assignment`,
  );
  assertUnchanged(
    author === previous.assignee,
    `only assignee ${previous.assignee ?? "<none>"} may mark a task '${next.action}'`,
  );
}
