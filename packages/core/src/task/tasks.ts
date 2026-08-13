import {
  MENTION_ROOM,
  assertInitialTask,
  assertTaskTransition,
  compareMessages,
  isTerminalTaskState,
  type AuthorKind,
  type Message,
  type Needs,
  type Task,
  type TaskAction,
  type TaskState,
} from "@komnet/protocol";
import { describeError } from "../errors.ts";

export type TaskHealth = "active" | "stale" | "blocked" | "stuck" | "done";

export interface InvalidTaskEvent {
  messageId: string;
  reason: string;
}

export interface TaskStatus {
  task: Task;
  rootMessageId: string;
  currentMessageId: string;
  definitionMessageId: string;
  thread: string;
  definition: string;
  updatedAt: string;
  staleAt: string;
  stale: boolean;
  health: TaskHealth;
  invalidEvents: InvalidTaskEvent[];
}

/**
 * One accepted event, rendered for a reader rather than for the state machine.
 *
 * Carries the body, because the body is where the work actually is: what was
 * tried, what it produced, what comes next. `TaskStatus` deliberately omits
 * these — a room with fifty tasks would otherwise ship fifty transcripts to
 * anyone who asked which tasks exist.
 */
export interface TaskEventView {
  messageId: string;
  ts: string;
  from: string;
  authorKind: AuthorKind;
  action: TaskAction;
  state: TaskState;
  needs: Needs;
  body: string;
  refs: string[];
}

/**
 * A task with its full accepted history.
 *
 * This is what makes long-running work resumable. An agent that lost its
 * context — a new session, a compacted conversation, or a peer taking over a
 * released task — can reconstruct the whole engagement from one call instead of
 * reading the room log and filtering it by hand.
 */
export interface TaskDetail extends TaskStatus {
  events: TaskEventView[];
  /** Every agent that authored an accepted event, in first-appearance order. */
  participants: string[];
}

function assertInitialEvent(message: Message): void {
  const task = message.header.task;
  if (task === undefined) throw new Error("message has no task snapshot");
  if (message.header.kind !== "question") {
    throw new Error("the initial task event must have kind 'question'");
  }
  if (message.header.thread !== message.header.id || message.header.inReplyTo !== undefined) {
    throw new Error("the initial task event must be the thread root");
  }
  if (message.header.needs !== "agent") {
    throw new Error("the initial task event must have needs 'agent'");
  }
  const destination = task.target ?? MENTION_ROOM;
  if (!message.header.mentions.includes(destination)) {
    throw new Error(`the initial task event must mention ${destination}`);
  }
  assertInitialTask(task, message.header.from);
}

function assertUpdateEvent(message: Message, acceptedIds: ReadonlySet<string>): void {
  const task = message.header.task;
  if (task === undefined) throw new Error("message has no task snapshot");
  if (message.header.kind !== "status") {
    throw new Error("task updates must have kind 'status'");
  }
  if (message.header.inReplyTo === undefined || !acceptedIds.has(message.header.inReplyTo)) {
    throw new Error("task updates must reply to an accepted event in the task thread");
  }

  if (message.header.needs === "human") {
    if (task.state !== "blocked" && task.state !== "stuck") {
      throw new Error("only a blocked or stuck task may request a human decision");
    }
    return;
  }
  const expectedNeeds =
    task.state === "open" || task.state === "blocked" || task.state === "stuck" ? "agent" : "none";
  if (message.header.needs !== expectedNeeds) {
    throw new Error(`task state '${task.state}' must have needs '${expectedNeeds}'`);
  }
}

function healthFor(task: Task, stale: boolean): TaskHealth {
  if (isTerminalTaskState(task.state)) return "done";
  if (task.state === "blocked") return "blocked";
  if (task.state === "stuck") return "stuck";
  return stale ? "stale" : "active";
}

interface ReducedTask {
  status: TaskStatus;
  /** Accepted events in protocol order, root first. */
  accepted: Message[];
}

function groupByTask(messages: readonly Message[]): Map<string, Message[]> {
  const byTask = new Map<string, Message[]>();
  for (const message of messages) {
    const task = message.header.task;
    if (task === undefined) continue;
    const bucket = byTask.get(task.id);
    if (bucket === undefined) byTask.set(task.id, [message]);
    else bucket.push(message);
  }
  return byTask;
}

/**
 * Reduce one task's events into its current state plus the events that produced
 * it. Events may branch so several agents can refine a task concurrently; they
 * are applied in ULID order, and a transition that loses a race is reported
 * under `invalidEvents` instead of silently overwriting an assignee.
 */
function reduceOne(events: Message[], now: number): ReducedTask | null {
  events.sort((a, b) => compareMessages(a.header, b.header));
  const invalidEvents: InvalidTaskEvent[] = [];
  let root: Message | undefined;
  let rootIndex = -1;

  for (const [index, event] of events.entries()) {
    try {
      assertInitialEvent(event);
      root = event;
      rootIndex = index;
      break;
    } catch (error) {
      invalidEvents.push({ messageId: event.header.id, reason: describeError(error) });
    }
  }
  if (root === undefined) return null;

  let current = root;
  let definition = root.body;
  let definitionMessageId = root.header.id;
  const accepted: Message[] = [root];
  const acceptedIds = new Set([root.header.id]);
  for (const event of events.slice(rootIndex + 1)) {
    const next = event.header.task as Task;
    try {
      if (event.header.thread !== root.header.thread) {
        throw new Error("task events must stay in the task's root thread");
      }
      assertUpdateEvent(event, acceptedIds);
      assertTaskTransition(current.header.task as Task, next, event.header.from);
      current = event;
      accepted.push(event);
      acceptedIds.add(event.header.id);
      if (next.action === "refined") {
        definition = event.body;
        definitionMessageId = event.header.id;
      }
    } catch (error) {
      invalidEvents.push({ messageId: event.header.id, reason: describeError(error) });
    }
  }

  const task = current.header.task as Task;
  const staleAtMs = Date.parse(current.header.ts) + task.staleAfterSeconds * 1000;
  const stale = !isTerminalTaskState(task.state) && now >= staleAtMs;
  return {
    accepted,
    status: {
      task,
      rootMessageId: root.header.id,
      currentMessageId: current.header.id,
      definitionMessageId,
      thread: root.header.thread,
      definition,
      updatedAt: current.header.ts,
      staleAt: new Date(staleAtMs).toISOString(),
      stale,
      health: healthFor(task, stale),
      invalidEvents,
    },
  };
}

function toEventView(message: Message): TaskEventView {
  const task = message.header.task as Task;
  return {
    messageId: message.header.id,
    ts: message.header.ts,
    from: message.header.from,
    authorKind: message.header.authorKind,
    action: task.action,
    state: task.state,
    needs: message.header.needs,
    body: message.body,
    refs: [...message.header.refs],
  };
}

/** Derive current task state from immutable events. */
export function reduceTasks(messages: readonly Message[], now = Date.now()): TaskStatus[] {
  const statuses: TaskStatus[] = [];
  for (const events of groupByTask(messages).values()) {
    const reduced = reduceOne(events, now);
    if (reduced !== null) statuses.push(reduced.status);
  }
  return statuses.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Reduce one task and keep the narrative: definition, every accepted event with
 * its body and refs, and who took part.
 */
export function reduceTaskDetail(
  messages: readonly Message[],
  taskId: string,
  now = Date.now(),
): TaskDetail | undefined {
  const events = groupByTask(messages).get(taskId);
  if (events === undefined) return undefined;
  const reduced = reduceOne(events, now);
  if (reduced === null) return undefined;

  const participants: string[] = [];
  for (const event of reduced.accepted) {
    if (!participants.includes(event.header.from)) participants.push(event.header.from);
  }
  return {
    ...reduced.status,
    events: reduced.accepted.map(toEventView),
    participants,
  };
}

/**
 * Threads that carry a task which has not reached a terminal state.
 *
 * Used to keep the room reply budget from parking work in progress. The budget
 * exists to stop two agents ping-ponging forever with nothing to show; a task
 * thread already has a stronger bound, because it must reach `completed` or
 * `cancelled` and its silence deadline surfaces it if it does not.
 */
export function activeTaskThreads(messages: readonly Message[], now = Date.now()): Set<string> {
  const threads = new Set<string>();
  for (const events of groupByTask(messages).values()) {
    const reduced = reduceOne(events, now);
    if (reduced === null) continue;
    if (!isTerminalTaskState(reduced.status.task.state)) threads.add(reduced.status.thread);
  }
  return threads;
}
