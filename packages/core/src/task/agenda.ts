import { isTerminalTaskState } from "@komnet/protocol";

import type { TaskStatus } from "./tasks.ts";

/** Why a task is on one agent's agenda. */
export const AGENDA_RELATIONS = ["assigned", "offered", "created", "unclaimed"] as const;
export type AgendaRelation = (typeof AGENDA_RELATIONS)[number];

export interface AgendaEntry {
  room: string;
  relation: AgendaRelation;
  /** True when this entry is stale, blocked, or stuck — i.e. it is not moving. */
  needsAttention: boolean;
  status: TaskStatus;
}

export interface AgendaCounts {
  assigned: number;
  offered: number;
  created: number;
  unclaimed: number;
  stale: number;
  blocked: number;
  stuck: number;
  /** Entries this agent owns or created that have stopped moving. */
  needsAttention: number;
}

export interface Agenda {
  entries: AgendaEntry[];
  counts: AgendaCounts;
}

export interface AgendaOptions {
  /** Include open tasks nobody has claimed. Default true — this is free work. */
  includeUnclaimed?: boolean;
  /** Cap the returned entries. Counts always describe the whole agenda. */
  limit?: number;
}

export interface RoomTasks {
  room: string;
  tasks: readonly TaskStatus[];
}

/**
 * Decide how one task relates to one agent, or that it does not.
 *
 * Order matters: an agent that created a task and then claimed it is working on
 * it, so `assigned` wins. A creator's own task that someone else owns still
 * shows up, because the creator is who chases it when it stops moving.
 */
function relationFor(
  status: TaskStatus,
  agentId: string,
  includeUnclaimed: boolean,
): AgendaRelation | null {
  const task = status.task;
  if (isTerminalTaskState(task.state)) return null;
  if (task.assignee === agentId) return "assigned";
  if (task.state === "open" && task.target === agentId) return "offered";
  if (task.creator === agentId) return "created";
  if (includeUnclaimed && task.state === "open" && task.target === undefined) return "unclaimed";
  return null;
}

const RELATION_ORDER: Record<AgendaRelation, number> = {
  assigned: 0,
  offered: 1,
  created: 2,
  unclaimed: 3,
};

/**
 * Build one agent's cross-room view of unfinished collaborative work.
 *
 * Rooms are the unit of subscription, not of attention: an agent carrying work
 * in five rooms has no way to see it as one commitment from `task list`, which
 * takes a room and reports everyone's tasks. This reduces the same events into
 * "what am I on the hook for, and what has stopped moving".
 *
 * Pure, so the ordering and the counting are testable without git.
 */
export function buildAgenda(
  rooms: readonly RoomTasks[],
  agentId: string,
  options: AgendaOptions = {},
): Agenda {
  const includeUnclaimed = options.includeUnclaimed ?? true;
  const entries: AgendaEntry[] = [];

  for (const { room, tasks } of rooms) {
    for (const status of tasks) {
      const relation = relationFor(status, agentId, includeUnclaimed);
      if (relation === null) continue;
      // An unclaimed task nobody owns is an offer, not a neglected commitment;
      // counting it as attention would make every idle backlog look on fire.
      const needsAttention = relation !== "unclaimed" && status.health !== "active";
      entries.push({ room, relation, needsAttention, status });
    }
  }

  // Things that stopped moving first, then by how long they have been ignored:
  // the oldest silence is the one most likely to have been forgotten.
  entries.sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
    const byRelation = RELATION_ORDER[a.relation] - RELATION_ORDER[b.relation];
    if (byRelation !== 0) return byRelation;
    return a.status.updatedAt.localeCompare(b.status.updatedAt);
  });

  const counts: AgendaCounts = {
    assigned: 0,
    offered: 0,
    created: 0,
    unclaimed: 0,
    stale: 0,
    blocked: 0,
    stuck: 0,
    needsAttention: 0,
  };
  for (const entry of entries) {
    counts[entry.relation] += 1;
    if (entry.needsAttention) counts.needsAttention += 1;
    if (entry.relation === "unclaimed") continue;
    if (entry.status.health === "stale") counts.stale += 1;
    else if (entry.status.health === "blocked") counts.blocked += 1;
    else if (entry.status.health === "stuck") counts.stuck += 1;
  }

  const limited =
    options.limit === undefined
      ? entries
      : entries.slice(0, Math.max(0, Math.floor(options.limit)));
  return { entries: limited, counts };
}
