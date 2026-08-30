/**
 * Collaborative tasks, as the network performs them.
 *
 * The reducer and the agenda are `../task/tasks.ts` and `../task/agenda.ts`;
 * this is the half that writes a transition into a room and decides who it
 * should reach.
 *
 * Depends on `./approvals.ts` rather than the other way round: claiming is
 * gated, and the gate knows nothing about tasks.
 */

import {
  MENTION_ROOM,
  TaskTransitionError,
  assertTaskTransition,
  createTask as createProtocolTask,
  taskTargetMachine,
  ulid,
  type Message,
  type Needs,
  type Task,
} from "@komnet/protocol";

import { buildAgenda, type Agenda, type AgendaOptions, type RoomTasks } from "../task/agenda.ts";
import { reduceTaskDetail, reduceTasks, type TaskDetail, type TaskStatus } from "../task/tasks.ts";
import type { ApprovalKind } from "../approvals.ts";
import type { ResumePoint, SendInput, TaskCreateInput, TaskUpdateInput } from "../network.ts";

/** What task orchestration needs from the network. */
export interface TasksContext {
  readonly agentId: string;
  /** This computer, so a task targeted at `machine:<id>` can be claimed here. */
  readonly machineId: string;
  /** Read live: a long-lived process picks up joins and leaves. */
  readonly subscriptions: readonly string[];
  send(roomId: string, input: SendInput): Promise<Message>;
  read(roomId: string): Promise<Message[]>;
  requireApproval(kind: ApprovalKind, roomId: string, id: string, requester: string): Promise<void>;
}

function taskForAction(
  previous: Task,
  input: TaskUpdateInput,
  author: string,
  authorMachine: string,
): Task {
  if (input.title !== undefined && input.action !== "refined") {
    throw new TaskTransitionError("only a refinement may provide a new task title");
  }
  if (input.target !== undefined && input.action !== "retargeted") {
    throw new TaskTransitionError("only retargeting may provide a new task target");
  }

  const base: Task = { ...previous, action: input.action };
  switch (input.action) {
    case "refined":
      return { ...base, title: input.title ?? previous.title };
    case "retargeted": {
      if (input.target === undefined) {
        throw new TaskTransitionError(
          "retargeting requires target=<agent> or target=null for free",
        );
      }
      const { target: _target, ...withoutTarget } = base;
      return input.target === null ? withoutTarget : { ...withoutTarget, target: input.target };
    }
    case "claimed": {
      // Stamp the machine the claim was made from when — and only when — the
      // task was aimed at one. That stamp is what every other machine validates
      // the claim against; without it the reducer would have to know the
      // claimer's card, and two readers could disagree.
      const targetMachine = taskTargetMachine(previous.target);
      return {
        ...base,
        state: "claimed",
        assignee: author,
        ...(targetMachine === null ? {} : { assigneeMachine: authorMachine }),
      };
    }
    case "started":
    case "progressed":
      return { ...base, state: "in_progress" };
    case "blocked":
      return { ...base, state: "blocked" };
    case "stuck":
      return { ...base, state: "stuck" };
    case "released": {
      const { assignee: _assignee, assigneeMachine: _machine, ...withoutAssignee } = base;
      return { ...withoutAssignee, state: "open" };
    }
    case "completed":
      return { ...base, state: "completed" };
    case "cancelled":
      return { ...base, state: "cancelled" };
    case "reopened": {
      const { assignee: _assignee, assigneeMachine: _machine, ...withoutAssignee } = base;
      return { ...withoutAssignee, state: "open" };
    }
  }
}

function taskNeeds(task: Task, needsHuman: boolean): Needs {
  if (needsHuman) return "human";
  return task.state === "open" || task.state === "blocked" || task.state === "stuck"
    ? "agent"
    : "none";
}

function taskMentions(previous: Task, next: Task, author: string): string[] {
  const recipients = new Set<string>();
  const add = (agent: string | undefined): void => {
    if (agent !== undefined && agent !== author) recipients.add(agent);
  };

  add(next.creator);
  if (next.state === "open") {
    recipients.add(next.target ?? MENTION_ROOM);
  } else {
    add(next.target);
    add(next.assignee);
  }
  // A free task was offered to the room. The winning claim is also announced
  // to the room so peers do not duplicate the work before their next list.
  if (next.action === "claimed" && previous.target === undefined) recipients.add(MENTION_ROOM);
  return [...recipients];
}

export async function createTask(
  ctx: TasksContext,
  roomId: string,
  input: TaskCreateInput,
): Promise<Message> {
  if (input.definition.trim().length === 0)
    throw new TypeError("task definition must not be empty");
  const task = createProtocolTask({
    id: ulid(),
    creator: ctx.agentId,
    title: input.title,
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(input.staleAfterSeconds === undefined
      ? {}
      : { staleAfterSeconds: input.staleAfterSeconds }),
  });
  return await ctx.send(roomId, {
    body: input.definition,
    kind: "question",
    needs: "agent",
    mentions: [task.target ?? MENTION_ROOM],
    priority: input.priority ?? "normal",
    tags: ["task", "task-state:open"],
    task,
  });
}

/** Current valid state of every collaborative task in a room. */
export async function listTasks(ctx: TasksContext, roomId: string): Promise<TaskStatus[]> {
  return reduceTasks(await ctx.read(roomId));
}

/**
 * One task with its whole accepted history.
 *
 * This is the resumption path. Long-running work outlives the session that
 * started it — a context window is compacted, a human closes the editor, a
 * released task is picked up by a different agent entirely — and without this
 * the only way back in is to read the room log and filter it by hand, which an
 * agent does badly and expensively. One call returns the definition as it now
 * stands, every accepted event with its evidence, and who has been involved.
 */
export async function showTask(
  ctx: TasksContext,
  roomId: string,
  taskId: string,
): Promise<TaskDetail> {
  const detail = reduceTaskDetail(await ctx.read(roomId), taskId);
  if (detail === undefined) throw new Error(`no task ${taskId} in room ${roomId}`);
  return detail;
}

/**
 * Unfinished work involving this agent, across every subscribed room.
 *
 * Rooms are the unit of subscription, not of attention. `listTasks` takes one
 * room and reports everyone's tasks; this reports one agent's commitments
 * wherever they live, with the ones that have stopped moving first.
 */
export async function agenda(ctx: TasksContext, options: AgendaOptions = {}): Promise<Agenda> {
  const rooms: RoomTasks[] = [];
  for (const roomId of ctx.subscriptions) {
    try {
      rooms.push({ room: roomId, tasks: await listTasks(ctx, roomId) });
    } catch {
      // One unreadable room must not hide the commitments in the others.
      continue;
    }
  }
  return buildAgenda(rooms, ctx.agentId, options, ctx.machineId);
}

/**
 * What this session was in the middle of, with the last thing it recorded.
 *
 * Long work outlives the session that started it, and a session that opens on
 * somebody else's mail anchors on somebody else's priorities for the rest of its
 * life. The agenda alone would only name the task; the last accepted event is
 * the part that stops the work being redone, so this pays one extra room read
 * per task to carry it.
 *
 * Bounded on purpose: an agent with eleven things in flight has a different
 * problem, and a brief that prints all eleven is one nobody reads.
 */
export async function resume(ctx: TasksContext, limit = 3): Promise<ResumePoint[]> {
  const list = await agenda(ctx, { includeUnclaimed: false });
  const points: ResumePoint[] = [];

  for (const entry of list.entries.filter((e) => e.inFlight).slice(0, Math.max(0, limit))) {
    const task = entry.status.task;
    const last = await showTask(ctx, entry.room, task.id)
      .then((detail) => detail.events.at(-1))
      .catch(() => undefined);
    points.push({
      room: entry.room,
      taskId: task.id,
      title: task.title,
      definition: entry.status.definition,
      health: entry.status.health,
      updatedAt: entry.status.updatedAt,
      ...(last === undefined
        ? {}
        : { last: { action: last.action, ts: last.ts, from: last.from, body: last.body } }),
    });
  }
  return points;
}

/** Claim a task for this agent and publish that assignment to its participants. */
export async function claimTask(
  ctx: TasksContext,
  roomId: string,
  taskId: string,
  body: string,
): Promise<Message> {
  return await updateTask(ctx, roomId, taskId, { action: "claimed", body });
}

/** Append one guarded task refinement, progress update, or lifecycle transition. */
export async function updateTask(
  ctx: TasksContext,
  roomId: string,
  taskId: string,
  input: TaskUpdateInput,
): Promise<Message> {
  if (input.body.trim().length === 0) throw new TypeError("task update must not be empty");
  const status = (await listTasks(ctx, roomId)).find((candidate) => candidate.task.id === taskId);
  if (status === undefined) throw new Error(`no task ${taskId} in room ${roomId}`);

  if (input.action === "claimed") {
    await ctx.requireApproval("task", roomId, taskId, status.task.creator);
  }

  const task = taskForAction(status.task, input, ctx.agentId, ctx.machineId);
  assertTaskTransition(status.task, task, ctx.agentId);
  if (input.needsHuman === true && task.action !== "blocked" && task.action !== "stuck") {
    throw new TaskTransitionError(
      "needs:human is allowed only for a blocked or stuck task that requires a critical human decision",
    );
  }

  const needs = taskNeeds(task, input.needsHuman === true);
  const mentions = taskMentions(status.task, task, ctx.agentId);
  const message = await ctx.send(roomId, {
    body: input.body,
    kind: "status",
    needs,
    ...(mentions.length === 0 ? {} : { mentions }),
    tags: ["task", `task-state:${task.state}`, `task-action:${task.action}`],
    ...(input.refs === undefined ? {} : { refs: input.refs }),
    inReplyTo: status.currentMessageId,
    thread: status.thread,
    task,
  });

  // A competing claim or stale snapshot remains a permanent, visible event, but
  // must not be reported to the caller as an accepted transition.
  const refreshed = (await listTasks(ctx, roomId)).find(
    (candidate) => candidate.task.id === taskId,
  );
  const rejected = refreshed?.invalidEvents.find((event) => event.messageId === message.header.id);
  if (rejected !== undefined) {
    throw new TaskTransitionError(`task update was not accepted: ${rejected.reason}`);
  }
  return message;
}
