import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMessage, createTask, ulid, type Message, type Task } from "@komnet/protocol";

import { observedPresenceWithActivity, PRESENCE_STALE_AFTER_MS } from "../src/agent/card.ts";
import { buildAgenda } from "../src/task/agenda.ts";
import { activeTaskThreads, reduceTaskDetail, reduceTasks } from "../src/task/tasks.ts";

function taskEvent(
  from: string,
  task: Task,
  options: {
    inReplyTo?: string;
    thread?: string;
    body?: string;
    ts?: string;
    refs?: string[];
  } = {},
): Message {
  const id = ulid();
  return createMessage({
    id,
    room: "tasks",
    from,
    authorKind: "agent",
    kind: task.action === "created" ? "question" : "status",
    needs:
      task.state === "open" || task.state === "blocked" || task.state === "stuck"
        ? "agent"
        : "none",
    mentions: task.action === "created" ? [task.target ?? "@room"] : [],
    thread: options.thread ?? id,
    ...(options.inReplyTo === undefined ? {} : { inReplyTo: options.inReplyTo }),
    ...(options.ts === undefined ? {} : { ts: options.ts }),
    ...(options.refs === undefined ? {} : { refs: options.refs }),
    body: options.body ?? `${task.action}\n`,
    task,
  });
}

/** A task carried from creation to `state`, as a chain of accepted events. */
function chain(
  creator: string,
  assignee: string,
  options: { title?: string; staleAfterSeconds?: number; startTs?: string } = {},
): { events: Message[]; task: Task } {
  const base = createTask({
    id: ulid(),
    creator,
    title: options.title ?? "Carry the refund migration",
    ...(options.staleAfterSeconds === undefined
      ? {}
      : { staleAfterSeconds: options.staleAfterSeconds }),
  });
  const at = (seconds: number): string =>
    new Date(
      Date.parse(options.startTs ?? "2026-08-12T10:00:00.000Z") + seconds * 1000,
    ).toISOString();

  const root = taskEvent(creator, base, { body: "Original definition.\n", ts: at(0) });
  const claimed: Task = { ...base, action: "claimed", state: "claimed", assignee };
  const claim = taskEvent(assignee, claimed, {
    inReplyTo: root.header.id,
    thread: root.header.thread,
    body: "Taking this; starting with the schema.\n",
    ts: at(10),
  });
  const started: Task = { ...claimed, action: "started", state: "in_progress" };
  const start = taskEvent(assignee, started, {
    inReplyTo: claim.header.id,
    thread: root.header.thread,
    body: "Started.\n",
    ts: at(20),
  });
  return { events: [root, claim, start], task: started };
}

describe("task detail", () => {
  it("returns the whole accepted narrative, with bodies, refs, and participants", () => {
    const { events, task } = chain("alice-codex", "bob-claude");
    const root = events[0] as Message;
    const last = events[2] as Message;
    const progressed: Task = { ...task, action: "progressed" };
    events.push(
      taskEvent("bob-claude", progressed, {
        inReplyTo: last.header.id,
        thread: root.header.thread,
        body: "Wrote the failing test; it reproduces.\n",
        ts: "2026-08-12T10:00:30.000Z",
        refs: ["acme/payments@abc123:src/refund.ts"],
      }),
    );

    const detail = reduceTaskDetail(events, task.id, Date.parse("2026-08-12T10:01:00.000Z"));
    assert.ok(detail !== undefined);
    assert.equal(detail.task.state, "in_progress");
    assert.equal(detail.task.assignee, "bob-claude");
    assert.deepEqual(
      detail.events.map((event) => event.action),
      ["created", "claimed", "started", "progressed"],
    );

    // The bodies are the point: this is what a resuming agent cannot rebuild.
    const progress = detail.events[3];
    assert.ok(progress !== undefined);
    assert.match(progress.body, /reproduces/);
    assert.deepEqual(progress.refs, ["acme/payments@abc123:src/refund.ts"]);
    assert.deepEqual(detail.participants, ["alice-codex", "bob-claude"]);
    assert.equal(detail.definition.trim(), "Original definition.");
  });

  it("keeps a refinement as the definition and reports rejected events", () => {
    const { events, task } = chain("alice-codex", "bob-claude");
    const root = events[0] as Message;
    const start = events[2] as Message;
    const refined: Task = { ...task, action: "refined", title: "Sharper title" };
    events.push(
      taskEvent("carol-cursor", refined, {
        inReplyTo: start.header.id,
        thread: root.header.thread,
        body: "Sharper definition.\n",
        ts: "2026-08-12T10:00:40.000Z",
      }),
    );
    // Not the assignee, so completing is refused — and stays visible.
    const stolen: Task = { ...task, action: "completed", state: "completed" };
    events.push(
      taskEvent("carol-cursor", stolen, {
        inReplyTo: start.header.id,
        thread: root.header.thread,
        body: "Declaring this done.\n",
        ts: "2026-08-12T10:00:50.000Z",
      }),
    );

    const detail = reduceTaskDetail(events, task.id, Date.parse("2026-08-12T10:01:00.000Z"));
    assert.ok(detail !== undefined);
    assert.equal(detail.definition.trim(), "Sharper definition.");
    assert.equal(detail.task.title, "Sharper title");
    assert.equal(detail.task.state, "in_progress", "a non-assignee must not complete the task");
    assert.equal(detail.invalidEvents.length, 1);
    assert.equal(detail.events.length, 4, "the rejected event is not part of the narrative");
    assert.deepEqual(detail.participants, ["alice-codex", "bob-claude", "carol-cursor"]);
  });

  it("is undefined for a task id the room does not carry", () => {
    const { events } = chain("alice-codex", "bob-claude");
    assert.equal(reduceTaskDetail(events, ulid()), undefined);
  });
});

describe("active task threads", () => {
  it("reports a thread while its task is unfinished and drops it once terminal", () => {
    const { events, task } = chain("alice-codex", "bob-claude");
    const root = events[0] as Message;
    assert.deepEqual([...activeTaskThreads(events)], [root.header.thread]);

    const completed: Task = { ...task, action: "completed", state: "completed" };
    events.push(
      taskEvent("bob-claude", completed, {
        inReplyTo: (events[2] as Message).header.id,
        thread: root.header.thread,
        body: "Landed.\n",
        ts: "2026-08-12T10:05:00.000Z",
      }),
    );
    assert.deepEqual([...activeTaskThreads(events)], []);
  });
});

describe("agenda", () => {
  const now = Date.parse("2026-08-12T12:00:00.000Z");

  function statusesFor(events: Message[]): ReturnType<typeof reduceTasks> {
    return reduceTasks(events, now);
  }

  it("classifies each task by how it relates to the reading agent", () => {
    const mine = chain("alice-codex", "bob-claude", { title: "Assigned to me" });
    const theirs = chain("bob-claude", "carol-cursor", { title: "I created it" });
    const offered = createTask({
      id: ulid(),
      creator: "alice-codex",
      title: "Offered to me",
      target: "bob-claude",
    });
    const free = createTask({ id: ulid(), creator: "alice-codex", title: "Anyone may take this" });

    const agenda = buildAgenda(
      [
        {
          room: "payments",
          tasks: statusesFor([
            ...mine.events,
            taskEvent("alice-codex", offered, { ts: "2026-08-12T11:00:00.000Z" }),
          ]),
        },
        {
          room: "social",
          tasks: statusesFor([
            ...theirs.events,
            taskEvent("alice-codex", free, { ts: "2026-08-12T11:00:00.000Z" }),
          ]),
        },
      ],
      "bob-claude",
      // Explicit, because "Assigned to me" is in flight and the default would
      // then keep free work out of the list. This case is about classification.
      { includeUnclaimed: true },
    );

    const byTitle = new Map(agenda.entries.map((e) => [e.status.task.title, e]));
    assert.equal(byTitle.get("Assigned to me")?.relation, "assigned");
    assert.equal(byTitle.get("Offered to me")?.relation, "offered");
    assert.equal(byTitle.get("I created it")?.relation, "created");
    assert.equal(byTitle.get("Anyone may take this")?.relation, "unclaimed");
    assert.equal(byTitle.get("Assigned to me")?.room, "payments");
    assert.equal(agenda.counts.assigned, 1);
    assert.equal(agenda.counts.offered, 1);
    assert.equal(agenda.counts.created, 1);
    assert.equal(agenda.counts.unclaimed, 1);
  });

  it("puts work that stopped moving first and counts it as attention", () => {
    // Two hours of silence against a one-minute threshold.
    const stalled = chain("alice-codex", "bob-claude", {
      title: "Silent since ten",
      staleAfterSeconds: 60,
      startTs: "2026-08-12T10:00:00.000Z",
    });
    const moving = chain("alice-codex", "bob-claude", {
      title: "Updated just now",
      staleAfterSeconds: 24 * 60 * 60,
      startTs: "2026-08-12T11:59:00.000Z",
    });

    const agenda = buildAgenda(
      [{ room: "payments", tasks: statusesFor([...stalled.events, ...moving.events]) }],
      "bob-claude",
    );

    assert.equal(agenda.entries[0]?.status.task.title, "Silent since ten");
    assert.equal(agenda.entries[0]?.needsAttention, true);
    assert.equal(agenda.entries[1]?.needsAttention, false);
    assert.equal(agenda.counts.needsAttention, 1);
    assert.equal(agenda.counts.stale, 1);
  });

  it("excludes finished work, and unclaimed work when asked", () => {
    const { events, task } = chain("alice-codex", "bob-claude");
    events.push(
      taskEvent(
        "bob-claude",
        { ...task, action: "completed", state: "completed" },
        {
          inReplyTo: (events[2] as Message).header.id,
          thread: (events[0] as Message).header.thread,
          body: "Done.\n",
          ts: "2026-08-12T10:30:00.000Z",
        },
      ),
    );
    const free = createTask({ id: ulid(), creator: "alice-codex", title: "Free work" });
    const tasks = statusesFor([...events, taskEvent("alice-codex", free)]);

    assert.equal(buildAgenda([{ room: "payments", tasks }], "bob-claude").counts.assigned, 0);
    assert.equal(buildAgenda([{ room: "payments", tasks }], "bob-claude").counts.unclaimed, 1);
    assert.equal(
      buildAgenda([{ room: "payments", tasks }], "bob-claude", { includeUnclaimed: false }).entries
        .length,
      0,
    );
  });

  it("puts the work in hand above work that is merely owed", () => {
    // Both are this agent's, both are moving; one it owns and one it only
    // created. The one it is actually doing has to lead, or the check-in that
    // was meant to re-anchor it becomes a list of other things to do.
    const inFlight = chain("alice-codex", "bob-claude", {
      title: "Mine, in progress",
      startTs: "2026-08-12T11:59:00.000Z",
    });
    const created = chain("bob-claude", "carol-cursor", {
      title: "Mine, someone else is on it",
      startTs: "2026-08-12T11:00:00.000Z",
    });
    const offered = createTask({
      id: ulid(),
      creator: "alice-codex",
      title: "Offered to me",
      target: "bob-claude",
    });

    const agenda = buildAgenda(
      [
        {
          room: "payments",
          tasks: statusesFor([
            ...created.events,
            taskEvent("alice-codex", offered, { ts: "2026-08-12T11:00:00.000Z" }),
            ...inFlight.events,
          ]),
        },
      ],
      "bob-claude",
    );

    assert.equal(agenda.entries[0]?.status.task.title, "Mine, in progress");
    assert.equal(agenda.entries[0]?.inFlight, true);
    assert.equal(agenda.counts.inFlight, 1);
    assert.deepEqual(agenda.inFlightThreads, [(inFlight.events[0] as Message).header.thread]);
    // Owned but not moved by this agent, so it is owed rather than in hand.
    assert.equal(agenda.entries.find((e) => e.relation === "created")?.inFlight, false);
  });

  it("stops offering free work while this agent has something in flight", () => {
    const free = createTask({ id: ulid(), creator: "alice-codex", title: "Anyone may take this" });
    const freeEvent = taskEvent("alice-codex", free, { ts: "2026-08-12T11:00:00.000Z" });
    const busy = chain("alice-codex", "bob-claude", { title: "Mine, in progress" });

    const idle = buildAgenda([{ room: "payments", tasks: statusesFor([freeEvent]) }], "bob-claude");
    assert.equal(idle.entries.length, 1, "an idle agent is still offered free work");
    assert.equal(idle.counts.unclaimed, 1);

    const rooms = [{ room: "payments", tasks: statusesFor([freeEvent, ...busy.events]) }];
    const engaged = buildAgenda(rooms, "bob-claude");
    assert.deepEqual(
      engaged.entries.map((e) => e.relation),
      ["assigned"],
      "free work is not ranked beside the task this agent is mid-way through",
    );
    assert.equal(engaged.counts.unclaimed, 1, "but it is still counted, so the offer is visible");

    // Explicit beats automatic, in both directions.
    assert.equal(buildAgenda(rooms, "bob-claude", { includeUnclaimed: true }).entries.length, 2);
    const mineOnly = buildAgenda(rooms, "bob-claude", { includeUnclaimed: false });
    assert.equal(mineOnly.entries.length, 1);
    assert.equal(mineOnly.counts.unclaimed, 0, "--mine drops it from the counts too");
  });

  it("does not count a stalled task as in flight", () => {
    const stalled = chain("alice-codex", "bob-claude", {
      title: "Silent since ten",
      staleAfterSeconds: 60,
      startTs: "2026-08-12T10:00:00.000Z",
    });
    const agenda = buildAgenda(
      [{ room: "payments", tasks: statusesFor(stalled.events) }],
      "bob-claude",
    );
    assert.equal(agenda.entries[0]?.inFlight, false);
    assert.equal(agenda.entries[0]?.needsAttention, true);
    assert.equal(agenda.counts.inFlight, 0);
    assert.deepEqual(agenda.inFlightThreads, [], "a task that stopped is not the work in hand");
  });

  it("limits the entries returned without distorting the counts", () => {
    const rooms = [
      {
        room: "payments",
        tasks: statusesFor([
          ...chain("alice-codex", "bob-claude", { title: "One" }).events,
          ...chain("alice-codex", "bob-claude", { title: "Two" }).events,
        ]),
      },
    ];
    const agenda = buildAgenda(rooms, "bob-claude", { limit: 1 });
    assert.equal(agenda.entries.length, 1);
    assert.equal(agenda.counts.assigned, 2, "counts describe the whole agenda, not the page");
  });
});

describe("presence corrected by activity", () => {
  const now = Date.parse("2026-08-12T12:00:00.000Z");
  const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();

  it("reports a working agent live even though its card has gone stale", () => {
    // Exactly the observed failure: one session, attached for hours, publishing
    // presence only on transition, so the card decays while the agent works.
    const presence = {
      status: "live" as const,
      lastSeen: iso(8 * 60 * 60_000),
      sessions: [{ id: "s1", since: iso(8 * 60 * 60_000) }],
    };
    assert.equal(
      observedPresenceWithActivity(presence, null, now),
      "stale",
      "with no evidence the old answer must stand",
    );
    assert.equal(observedPresenceWithActivity(presence, now - 60_000, now), "live");
  });

  it("ignores activity that predates the card, so a departure is not undone", () => {
    const presence = {
      status: "away" as const,
      lastSeen: iso(2 * 60_000),
      sessions: [],
    };
    assert.equal(observedPresenceWithActivity(presence, now - 5 * 60_000, now), "away");
  });

  it("ignores activity older than the staleness window, and clock skew from the future", () => {
    const presence = {
      status: "live" as const,
      lastSeen: iso(8 * 60 * 60_000),
      sessions: [],
    };
    assert.equal(
      observedPresenceWithActivity(presence, now - PRESENCE_STALE_AFTER_MS - 1_000, now),
      "stale",
    );
    assert.equal(observedPresenceWithActivity(presence, now + 10 * 60_000, now), "stale");
  });
});
