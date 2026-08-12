import {
  MENTION_ROOM,
  assertInitialTask,
  assertTaskTransition,
  compareMessages,
  isTerminalTaskState,
  type Message,
  type Task,
} from "@komnet/protocol";

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

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/**
 * Derive current task state from immutable events.
 *
 * Events may branch so several agents can refine a task concurrently. They are
 * reduced in ULID order; every update may reply to any previously accepted
 * event, while guarded transitions make competing claims deterministic and
 * report the losing event instead of silently overwriting an assignee.
 */
export function reduceTasks(messages: readonly Message[], now = Date.now()): TaskStatus[] {
  const byTask = new Map<string, Message[]>();
  for (const message of messages) {
    const task = message.header.task;
    if (task === undefined) continue;
    const bucket = byTask.get(task.id);
    if (bucket === undefined) byTask.set(task.id, [message]);
    else bucket.push(message);
  }

  const statuses: TaskStatus[] = [];
  for (const events of byTask.values()) {
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
        invalidEvents.push({ messageId: event.header.id, reason: reason(error) });
      }
    }
    if (root === undefined) continue;

    let current = root;
    let definition = root.body;
    let definitionMessageId = root.header.id;
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
        acceptedIds.add(event.header.id);
        if (next.action === "refined") {
          definition = event.body;
          definitionMessageId = event.header.id;
        }
      } catch (error) {
        invalidEvents.push({ messageId: event.header.id, reason: reason(error) });
      }
    }

    const task = current.header.task as Task;
    const staleAtMs = Date.parse(current.header.ts) + task.staleAfterSeconds * 1000;
    const stale = !isTerminalTaskState(task.state) && now >= staleAtMs;
    statuses.push({
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
    });
  }

  return statuses.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
