import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { createMessage, createTask, ulid, type Message, type Task } from "@komnet/protocol";

import { defaultIdentity } from "../src/config.ts";
import { Layout } from "../src/layout.ts";
import { Network } from "../src/network.ts";
import { unresolvedMessages } from "../src/seal/unresolved.ts";
import { reduceTasks } from "../src/task/tasks.ts";

const exec = promisify(execFile);

function taskEvent(
  from: string,
  task: Task,
  options: { inReplyTo?: string; thread?: string; body?: string; ts?: string } = {},
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
    body: options.body ?? `${task.action}\n`,
    task,
  });
}

process.env["GIT_AUTHOR_NAME"] = "komnet test";
process.env["GIT_AUTHOR_EMAIL"] = "test@komnet.invalid";
process.env["GIT_COMMITTER_NAME"] = "komnet test";
process.env["GIT_COMMITTER_EMAIL"] = "test@komnet.invalid";

describe("task event reduction", () => {
  it("merges collaborative refinements, resolves competing claims, and surfaces staleness", () => {
    const open = createTask({
      id: ulid(),
      creator: "alice-codex",
      title: "Initial title",
      staleAfterSeconds: 60,
    });
    const root = taskEvent("alice-codex", open, {
      body: "Initial definition.\n",
      ts: "2026-08-12T10:00:00.000Z",
    });
    const refinedA = { ...open, action: "refined" as const, title: "First refinement" };
    const first = taskEvent("bob-codex", refinedA, {
      inReplyTo: root.header.id,
      thread: root.header.thread,
      body: "First refined definition.\n",
      ts: "2026-08-12T10:00:10.000Z",
    });
    const refinedB = { ...open, action: "refined" as const, title: "Final refinement" };
    const second = taskEvent("carol-claude", refinedB, {
      inReplyTo: root.header.id,
      thread: root.header.thread,
      body: "Final refined definition.\n",
      ts: "2026-08-12T10:00:20.000Z",
    });
    const aliceClaim = {
      ...refinedB,
      action: "claimed" as const,
      state: "claimed" as const,
      assignee: "alice-codex",
    };
    const winning = taskEvent("alice-codex", aliceClaim, {
      inReplyTo: second.header.id,
      thread: root.header.thread,
      ts: "2026-08-12T10:00:30.000Z",
    });
    const bobClaim = {
      ...refinedB,
      action: "claimed" as const,
      state: "claimed" as const,
      assignee: "bob-codex",
    };
    const losing = taskEvent("bob-codex", bobClaim, {
      inReplyTo: second.header.id,
      thread: root.header.thread,
      ts: "2026-08-12T10:00:31.000Z",
    });

    const [status] = reduceTasks(
      [losing, second, root, winning, first],
      Date.parse("2026-08-12T10:02:00.000Z"),
    );
    assert.equal(status?.task.assignee, "alice-codex");
    assert.equal(status?.task.title, "Final refinement");
    assert.equal(status?.definition, "Final refined definition.\n");
    assert.equal(status?.stale, true);
    assert.equal(status?.health, "stale");
    assert.deepEqual(
      status?.invalidEvents.map((event) => event.messageId),
      [losing.header.id],
    );
  });

  it("protects an active task from sealing even when its claim needs no reply", () => {
    const open = createTask({ id: ulid(), creator: "alice-codex", title: "Stay live" });
    const root = taskEvent("alice-codex", open);
    const claimed = {
      ...open,
      action: "claimed" as const,
      state: "claimed" as const,
      assignee: "bob-codex",
    };
    const claim = taskEvent("bob-codex", claimed, {
      inReplyTo: root.header.id,
      thread: root.header.thread,
    });
    assert.equal(claim.header.needs, "none");
    assert.deepEqual(
      unresolvedMessages([root, claim]).map((message) => message.header.id),
      [claim.header.id],
    );
  });

  it("rejects an incoming non-critical task event that asks for a human", () => {
    const open = createTask({ id: ulid(), creator: "alice-codex", title: "Agent-owned work" });
    const root = taskEvent("alice-codex", open);
    const claimed = {
      ...open,
      action: "claimed" as const,
      state: "claimed" as const,
      assignee: "bob-codex",
    };
    const claim = createMessage({
      id: ulid(),
      room: "tasks",
      from: "bob-codex",
      authorKind: "agent",
      kind: "status",
      needs: "human",
      mentions: ["alice-codex"],
      thread: root.header.thread,
      inReplyTo: root.header.id,
      body: "Routine ownership does not require a person.\n",
      task: claimed,
    });

    const [status] = reduceTasks([root, claim]);
    assert.equal(status?.task.state, "open");
    assert.deepEqual(
      status?.invalidEvents.map((event) => event.messageId),
      [claim.header.id],
    );
  });
});

describe("task lifecycle integration", () => {
  let tmp: string;
  let alice: Network;
  let bob: Network;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "komnet-task-"));
    const remote = join(tmp, "transport.git");
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
    alice = (
      await Network.init({
        layout: new Layout(join(tmp, "alice")),
        networkId: "acme",
        remote,
        identity: defaultIdentity({ id: "alice-codex" }),
      })
    ).network;
    await alice.createRoom("tasks");
    bob = (
      await Network.init({
        layout: new Layout(join(tmp, "bob")),
        networkId: "acme",
        remote,
        identity: defaultIdentity({ id: "bob-codex" }),
      })
    ).network;
    await bob.joinRoom("tasks");

    // This suite is about the task lifecycle, not about who may take work on.
    // Said explicitly rather than left to the default, so the two concerns stay
    // separable: the inbound-work gate has its own suite in policy.test.ts.
    await writeFile(join(tmp, "bob", "policy.yaml"), "v: 1\napprovals:\n  inboundWork: never\n");
  });

  after(async () => {
    alice.close();
    bob.close();
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("publishes assignment and moves through blocked/stuck without casual human escalation", async () => {
    const created = await alice.createTask("tasks", {
      title: "Implement task protocol",
      definition: "Add append-only task lifecycle messages.",
      staleAfterSeconds: 3600,
    });
    assert.equal(created.header.needs, "agent");
    assert.deepEqual(created.header.mentions, ["@room"]);

    await bob.sync();
    const taskId = created.header.task?.id as string;
    await assert.rejects(
      bob.updateTask("tasks", taskId, {
        action: "refined",
        title: "invalid\ntitle",
        body: "This malformed snapshot must never be written.",
      }),
      /task_title must be one non-empty line/,
    );
    const claimed = await bob.claimTask("tasks", taskId, "Claimed; starting with protocol fields.");
    assert.equal(claimed.header.task?.assignee, "bob-codex");
    assert.ok(claimed.header.mentions.includes("@room"));

    await bob.updateTask("tasks", taskId, { action: "started", body: "Protocol work started." });
    await assert.rejects(
      bob.updateTask("tasks", taskId, {
        action: "progressed",
        body: "Ordinary progress does not need a person.",
        needsHuman: true,
      }),
      /needs:human is allowed only/,
    );
    const blocked = await bob.updateTask("tasks", taskId, {
      action: "blocked",
      body: "Waiting for an agent-owned contract decision.",
    });
    assert.equal(blocked.header.needs, "agent");
    const stuck = await bob.updateTask("tasks", taskId, {
      action: "stuck",
      body: "A release-policy decision now has consequences only the Head of Engineering can own.",
      needsHuman: true,
    });
    assert.equal(stuck.header.needs, "human");

    await bob.updateTask("tasks", taskId, {
      action: "started",
      body: "Decision received; resumed.",
    });
    await bob.updateTask("tasks", taskId, {
      action: "completed",
      body: "Implemented and verified.",
    });

    await alice.sync();
    const [status] = await alice.listTasks("tasks");
    assert.equal(status?.task.state, "completed");
    assert.equal(status?.task.assignee, "bob-codex");
    assert.equal(status?.health, "done");
  });
});
