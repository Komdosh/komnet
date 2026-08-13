import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { createMessage, messagePath, roomRef, ulid } from "@komnet/protocol";
import type { Message } from "@komnet/protocol";

import {
  CadenceController,
  DEFAULT_CADENCE,
  GitRunner,
  Layout,
  Repo,
  RoomStore,
  assessThreadPressure,
  backoffDelay,
  collectRoomUpdate,
  createRoomConfig,
  describeFindings,
  diffRoomHeads,
  failureBackoff,
  intervalFor,
  nextState,
  observedPresenceStatus,
  parseRoomConfig,
  scanForSecrets,
  serializeRoomConfig,
  shannonEntropy,
  shouldDeliverMessage,
  steadyPollDelay,
} from "../src/index.ts";

// Deterministic authorship so commits do not depend on the machine's git config.
process.env["GIT_AUTHOR_NAME"] = "komnet test";
process.env["GIT_AUTHOR_EMAIL"] = "test@komnet.invalid";
process.env["GIT_COMMITTER_NAME"] = "komnet test";
process.env["GIT_COMMITTER_EMAIL"] = "test@komnet.invalid";

const ROOM = "architecture";
const runner = new GitRunner();

let tmp: string;

function message(from: string, body: string): Message {
  return createMessage({
    id: ulid(),
    room: ROOM,
    from,
    authorKind: "agent",
    kind: "msg",
    needs: "none",
    body,
  });
}

/** A bare remote carrying `main` and an orphan `room/architecture`. */
async function seedRemote(name: string): Promise<string> {
  const remote = join(tmp, `${name}.git`);
  await Repo.initBare(remote, runner);

  const seed = join(tmp, `${name}-seed`);
  await runner.run(["clone", "--quiet", remote, seed], { cwd: tmp });
  const seedRepo = new Repo(seed, runner);

  await seedRepo.commitFile(seed, ".komnet/net.yaml", "v: 1\nid: test\n", "komnet: init network");
  await seedRepo.pushNewBranch(seed, "main");

  // Room branches are orphans so they carry only their own room (ADR 0003).
  await runner.run(["switch", "--orphan", roomRef(ROOM)], { cwd: seed });
  await runner.run(["commit", "--quiet", "--allow-empty", "-m", "komnet: open room"], {
    cwd: seed,
  });
  await seedRepo.pushNewBranch(seed, roomRef(ROOM));

  return remote;
}

/** A clone standing in for one agent's machine. */
async function makeAgent(remote: string, name: string): Promise<{ repo: Repo; dir: string }> {
  const dir = join(tmp, name);
  await runner.run(["clone", "--quiet", "--branch", roomRef(ROOM), remote, dir], { cwd: tmp });
  return { repo: new Repo(dir, runner), dir };
}

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "komnet-test-"));
});

after(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("git transport", () => {
  it("maps room branches to heads in one ls-remote", async () => {
    const remote = await seedRemote("lsremote");
    const agent = await makeAgent(remote, "lsremote-a");

    const rooms = await agent.repo.lsRemoteRooms(remote);
    assert.deepEqual([...rooms.keys()], [ROOM], "only room/* refs, not main");
    assert.match(rooms.get(ROOM) as string, /^[0-9a-f]{40}$/);
  });

  it("discovers main and room heads in one snapshot", async () => {
    const remote = await seedRemote("heads");
    const agent = await makeAgent(remote, "heads-a");

    const heads = await agent.repo.lsRemoteHeads(remote);
    assert.match(heads.main as string, /^[0-9a-f]{40}$/);
    assert.deepEqual([...heads.rooms.keys()], [ROOM]);
  });

  it("converges when two agents push concurrently (ADR 0004)", async () => {
    const remote = await seedRemote("race");
    const alice = await makeAgent(remote, "race-alice");
    const bob = await makeAgent(remote, "race-bob");

    // Both write while holding the SAME base commit — a genuine race.
    const aliceMsg = message("alice-cursor", "from alice");
    const bobMsg = message("bob-codex", "from bob");

    const aliceStore = new RoomStore(alice.dir, ROOM);
    const bobStore = new RoomStore(bob.dir, ROOM);
    await aliceStore.writeMessage(aliceMsg);
    await bobStore.writeMessage(bobMsg);

    await runner.run(["add", "-A"], { cwd: alice.dir });
    await runner.run(["commit", "--quiet", "-m", "alice"], { cwd: alice.dir });
    await runner.run(["add", "-A"], { cwd: bob.dir });
    await runner.run(["commit", "--quiet", "-m", "bob"], { cwd: bob.dir });

    const first = await alice.repo.pushWithRetry(alice.dir, roomRef(ROOM), {
      sleep: async () => {},
    });
    assert.equal(first.attempts, 1);
    assert.equal(first.rebased, false);

    // Bob is now behind: this must reject, rebase, and land without conflict.
    const second = await bob.repo.pushWithRetry(bob.dir, roomRef(ROOM), { sleep: async () => {} });
    assert.ok(second.attempts > 1, "the losing push must have retried");
    assert.ok(second.rebased, "and must have rebased onto the new head");

    // Both messages survive — neither clobbered the other.
    const verify = await makeAgent(remote, "race-verify");
    const paths = await new RoomStore(verify.dir, ROOM).listMessagePaths();
    assert.equal(paths.length, 2);
    assert.ok(paths.includes(messagePath(aliceMsg.header)));
    assert.ok(paths.includes(messagePath(bobMsg.header)));
  });

  it("surfaces added messages between two heads, ignoring non-messages", async () => {
    const remote = await seedRemote("detect");
    const agent = await makeAgent(remote, "detect-a");
    const store = new RoomStore(agent.dir, ROOM);

    const before = await agent.repo.resolveRef("HEAD");
    const msg = message("alice-cursor", "hello there");
    await store.writeMessage(msg);
    await runner.run(["add", "-A"], { cwd: agent.dir });
    await runner.run(["commit", "--quiet", "-m", "msg"], { cwd: agent.dir });
    const after = await agent.repo.resolveRef("HEAD");

    const update = await collectRoomUpdate(agent.repo, {
      roomId: ROOM,
      from: before,
      to: after as string,
    });

    assert.equal(update.messages.length, 1);
    assert.equal(update.messages[0]?.header.id, msg.header.id);
    assert.equal(update.messages[0]?.body.trim(), "hello there");
    assert.deepEqual(update.anomalies, []);
    assert.deepEqual(update.unreadable, []);
  });

  it("reports a modified message as an anomaly rather than applying it", async () => {
    const remote = await seedRemote("anomaly");
    const agent = await makeAgent(remote, "anomaly-a");
    const store = new RoomStore(agent.dir, ROOM);

    const msg = message("alice-cursor", "original");
    const repoPath = await store.writeMessage(msg);
    await runner.run(["add", "-A"], { cwd: agent.dir });
    await runner.run(["commit", "--quiet", "-m", "add"], { cwd: agent.dir });
    const before = (await agent.repo.resolveRef("HEAD")) as string;

    // Hand-edit an existing message: a protocol violation.
    await agent.repo.commitFile(agent.dir, repoPath, "tampered", "tamper");
    const after = (await agent.repo.resolveRef("HEAD")) as string;

    const update = await collectRoomUpdate(agent.repo, { roomId: ROOM, from: before, to: after });
    assert.equal(update.messages.length, 0, "a modification must not be delivered as a message");
    assert.equal(update.anomalies.length, 1);
    assert.equal(update.anomalies[0]?.status, "modified");
  });

  it("refuses to overwrite an existing message file", async () => {
    const remote = await seedRemote("nodup");
    const agent = await makeAgent(remote, "nodup-a");
    const store = new RoomStore(agent.dir, ROOM);

    const msg = message("alice-cursor", "once");
    await store.writeMessage(msg);
    await assert.rejects(() => store.writeMessage(msg), /EEXIST/);
  });

  it("reads the live window in thread order", async () => {
    const remote = await seedRemote("window");
    const agent = await makeAgent(remote, "window-a");
    const store = new RoomStore(agent.dir, ROOM);

    const root = message("alice-cursor", "question");
    await store.writeMessage(root);
    const reply = createMessage({
      id: ulid(),
      room: ROOM,
      from: "bob-codex",
      authorKind: "agent",
      kind: "answer",
      needs: "none",
      thread: root.header.id,
      inReplyTo: root.header.id,
      body: "answer",
    });
    await store.writeMessage(reply);

    const all = await store.readAll();
    assert.deepEqual(
      all.map((m) => m.header.id),
      [root.header.id, reply.header.id],
    );
  });

  it("reports an empty room rather than failing", async () => {
    const remote = await seedRemote("empty");
    const agent = await makeAgent(remote, "empty-a");
    assert.deepEqual(await new RoomStore(agent.dir, ROOM).listMessagePaths(), []);
  });
});

describe("head diffing", () => {
  const subscribed = new Set([ROOM, "checkout"]);

  it("reports only subscribed rooms that moved", () => {
    const known = new Map([[ROOM, "aaa"]]);
    const remote = new Map([
      [ROOM, "bbb"],
      ["checkout", "ccc"],
      ["unrelated", "ddd"],
    ]);

    const diff = diffRoomHeads(known, remote, subscribed);
    assert.deepEqual(diff.changed, [
      { roomId: ROOM, from: "aaa", to: "bbb" },
      { roomId: "checkout", from: null, to: "ccc" },
    ]);
    assert.deepEqual(diff.unsubscribed, ["unrelated"], "discovery only, never fetched");
    assert.deepEqual(diff.vanished, []);
  });

  it("reports nothing when nothing moved", () => {
    const heads = new Map([[ROOM, "aaa"]]);
    assert.deepEqual(diffRoomHeads(heads, heads, subscribed).changed, []);
  });

  it("notices a closed room", () => {
    const diff = diffRoomHeads(new Map([[ROOM, "aaa"]]), new Map(), subscribed);
    assert.deepEqual(diff.vanished, [ROOM]);
  });
});

describe("cadence", () => {
  const base = {
    now: 1_000_000,
    lastActivityAt: 1_000_000,
    hasPendingHumanDecision: false,
    sessionLive: false,
    online: true,
    suspended: false,
  };

  it("tracks activity age", () => {
    assert.equal(nextState(base), "hot");
    assert.equal(nextState({ ...base, lastActivityAt: base.now - 10 * 60_000 }), "warm");
    assert.equal(nextState({ ...base, lastActivityAt: base.now - 5 * 60 * 60_000 }), "cool");
    assert.equal(nextState({ ...base, lastActivityAt: base.now - 48 * 60 * 60_000 }), "idle");
    assert.equal(nextState({ ...base, lastActivityAt: null }), "idle");
  });

  it("goes hot the moment a session opens, however quiet the room", () => {
    const quiet = { ...base, lastActivityAt: null, sessionLive: true };
    assert.equal(nextState(quiet), "hot", "freshness has value exactly when a human is present");
  });

  it("holds at warm while a human decision is outstanding", () => {
    const stale = { ...base, lastActivityAt: base.now - 48 * 60 * 60_000 };
    assert.equal(nextState(stale), "idle");
    assert.equal(nextState({ ...stale, hasPendingHumanDecision: true }), "warm");
  });

  it("pauses when offline or suspended", () => {
    assert.equal(nextState({ ...base, online: false }), "paused");
    assert.equal(nextState({ ...base, suspended: true }), "paused");
    assert.equal(intervalFor("paused"), null);
  });

  it("backs off past the nominal cadence while failing", () => {
    const controller = new CadenceController();
    assert.equal(
      controller.nextDelay(base, () => 0.5),
      DEFAULT_CADENCE.hotMs,
    );

    for (let i = 0; i < 8; i++) controller.recordFailure();
    const delay = controller.nextDelay(base, () => 1) as number;
    assert.ok(delay > DEFAULT_CADENCE.hotMs, "a failing sync must not keep polling at hot cadence");

    controller.recordSuccess();
    assert.equal(
      controller.nextDelay(base, () => 0.5),
      DEFAULT_CADENCE.hotMs,
    );
  });

  it("spreads retries from the first failure instead of clamping them into a herd", () => {
    const controller = new CadenceController();
    controller.recordFailure();
    assert.equal(
      controller.nextDelay(base, () => 0),
      DEFAULT_CADENCE.hotMs,
    );
    assert.ok((controller.nextDelay(base, () => 0.9) as number) > DEFAULT_CADENCE.hotMs);
  });

  it("jitters healthy polls around the nominal interval", () => {
    assert.equal(
      steadyPollDelay(10_000, 0.2, () => 0),
      8_000,
    );
    assert.equal(
      steadyPollDelay(10_000, 0.2, () => 0.5),
      10_000,
    );
    assert.equal(
      steadyPollDelay(10_000, 0.2, () => 1),
      12_000,
    );
  });

  it("jitters backoff so peers do not retry in lockstep", () => {
    assert.equal(
      failureBackoff(3, DEFAULT_CADENCE, () => 0),
      0,
    );
    const full = failureBackoff(3, DEFAULT_CADENCE, () => 0.999);
    assert.ok(full > 0 && full <= DEFAULT_CADENCE.failureCapMs);
    assert.equal(failureBackoff(0), 0);
  });

  it("caps push backoff and keeps it jittered", () => {
    assert.equal(
      backoffDelay(1, 200, 15_000, () => 0),
      0,
    );
    assert.equal(
      backoffDelay(50, 200, 15_000, () => 0.5),
      7_500,
      "must respect the cap",
    );
  });
});

describe("shared-room pressure", () => {
  it("marks an old live transition stale without heartbeat commits", () => {
    const now = Date.parse("2026-08-11T12:30:00.000Z");
    assert.equal(
      observedPresenceStatus(
        { status: "live", lastSeen: "2026-08-11T12:20:00.000Z", sessions: [] },
        now,
      ),
      "live",
    );
    assert.equal(
      observedPresenceStatus(
        { status: "live", lastSeen: "2026-08-11T12:00:00.000Z", sessions: [] },
        now,
      ),
      "stale",
    );
    assert.equal(
      observedPresenceStatus(
        { status: "away", lastSeen: "2026-08-01T12:00:00.000Z", sessions: [] },
        now,
      ),
      "away",
    );
    assert.equal(
      observedPresenceStatus(
        { status: "live", lastSeen: "2026-08-11T13:00:00.000Z", sessions: [] },
        now,
      ),
      "stale",
      "a peer clock far in the future must not create an extended false-live window",
    );
  });

  it("targets mentioned human requests instead of broadcasting them", () => {
    const targeted = createMessage({
      id: ulid(),
      room: ROOM,
      from: "alice-cursor",
      authorKind: "agent",
      kind: "question",
      needs: "human",
      mentions: ["bob-codex"],
      body: "choose one",
    });
    assert.ok(shouldDeliverMessage(targeted, "bob-codex", new Set([ROOM])));
    assert.ok(!shouldDeliverMessage(targeted, "carol-claude", new Set([ROOM])));

    const unaddressed = { ...targeted, header: { ...targeted.header, mentions: [] } };
    assert.ok(shouldDeliverMessage(unaddressed, "carol-claude", new Set([ROOM])));
  });

  it("parks the last allowed consecutive agent reply for a cooperative human handoff", () => {
    const root = message("alice-cursor", "proposal");
    const messages: Message[] = [root];
    for (let index = 0; index < 4; index += 1) {
      messages.push(
        createMessage({
          id: ulid(),
          room: ROOM,
          from: index % 2 === 0 ? "bob-codex" : "alice-cursor",
          authorKind: "agent",
          kind: "answer",
          needs: "none",
          thread: root.header.id,
          inReplyTo: (messages.at(-1) as Message).header.id,
          body: `reply ${String(index)}`,
        }),
      );
    }

    const pressure = assessThreadPressure(messages, root.header.id, 6);
    assert.equal(pressure.consecutiveAgentMessages, 5);
    assert.ok(pressure.shouldPark);

    messages.push(
      createMessage({
        id: ulid(),
        room: ROOM,
        from: "alice-cursor",
        authorKind: "human",
        kind: "answer",
        needs: "none",
        thread: root.header.id,
        body: "human direction",
      }),
    );
    assert.equal(
      assessThreadPressure(messages, root.header.id, 6).consecutiveAgentMessages,
      0,
      "a declared human relay starts a fresh cooperative budget",
    );
  });
});

describe("secret scanner", () => {
  it("catches real credential shapes", () => {
    const cases: [string, string][] = [
      ["AKIAIOSFODNN7EXAMPLE", "aws-access-key-id"],
      [`ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8".slice(0, 36)}`, "github-token"],
      ["-----BEGIN OPENSSH PRIVATE KEY-----", "private-key-block"],
      ["postgres://svc:8Jd0aQ2mZk91@db.internal:5432/app", "connection-string-password"],
      ["xoxb-1234567890-abcdefghijkl", "slack-token"],
    ];
    for (const [text, rule] of cases) {
      const findings = scanForSecrets(text);
      assert.ok(
        findings.some((f) => f.rule === rule),
        `expected ${rule} for ${text.slice(0, 12)}…`,
      );
    }
  });

  it("never echoes the secret in a finding", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const findings = scanForSecrets(`aws key: ${secret}`);
    const rendered = JSON.stringify(findings) + describeFindings(findings);
    assert.doesNotMatch(rendered, /AKIA/, "the scanner must not copy secrets into its own output");
  });

  it("reports position so the sender can find it", () => {
    const findings = scanForSecrets("line one\nline two AKIAIOSFODNN7EXAMPLE\n");
    assert.equal(findings[0]?.line, 2);
    assert.ok((findings[0]?.column ?? 0) > 1);
  });

  it("does not block ordinary prose or placeholders", () => {
    const benign = [
      "The password rotation policy is documented in the runbook.",
      "Set password = <your-password-here> in the env file.",
      "token: REDACTED",
      "api_key = xxxxxxxxxxxx",
      "We should discuss the secret sauce of our ranking.",
      "password: hunter2",
    ];
    for (const text of benign) {
      assert.deepEqual(scanForSecrets(text), [], `false positive on: ${text}`);
    }
  });

  it("gates the broad assignment rule on entropy", () => {
    assert.deepEqual(scanForSecrets("password = passwords"), []);
    assert.ok(scanForSecrets('api_key = "8Jd0aQ2mZk91LpXvT3Ru7Yc5"').length > 0);
  });

  it("computes entropy sanely", () => {
    assert.equal(shannonEntropy(""), 0);
    assert.equal(shannonEntropy("aaaa"), 0);
    assert.ok(shannonEntropy("8Jd0aQ2mZk91LpXv") > 3.2);
  });

  it("accepts organisation-specific rules", () => {
    const findings = scanForSecrets("acme_abcdefghij0123456789abcdefghij01", {
      extraRules: [{ name: "acme-token", pattern: /\bacme_[a-z0-9]{32}\b/g }],
    });
    assert.equal(findings[0]?.rule, "acme-token");
  });
});

describe("room config", () => {
  it("no longer writes the retired decisions_require_human key", () => {
    const yaml = serializeRoomConfig(
      createRoomConfig({ id: "architecture", createdBy: "a-codex" }),
    );
    assert.doesNotMatch(yaml, /decisions_require_human/);
    assert.match(yaml, /reply_budget/);
  });

  it("still reads a room.yaml written before the key was retired", () => {
    // Existing files are never rewritten, so the key survives in older rooms.
    // Ignoring it must not cost the rest of the config.
    const legacy = [
      "v: 1",
      "id: architecture",
      "title: Architecture",
      "purpose: ''",
      "status: open",
      "created: 2026-01-01T00:00:00.000Z",
      "created_by: a-codex",
      "participants: [a-codex]",
      "policy:",
      "  decisions_require_human: true",
      "  reply_budget: 7",
      "retention:",
      "  window: { days: 30, messages: 500 }",
      "  seal: { min_interval_hours: 24 }",
      "",
    ].join("\n");
    const parsed = parseRoomConfig(legacy);
    assert.equal(parsed.policy.replyBudget, 7);
    assert.equal(parsed.id, "architecture");
    assert.ok(!("decisionsRequireHuman" in parsed.policy));
  });
});

describe("layout", () => {
  it("keeps one object store shared by all worktrees", () => {
    const layout = new Layout("/tmp/komnet-home");
    assert.equal(layout.gitDir("acme"), "/tmp/komnet-home/networks/acme/git");
    assert.equal(layout.recordWorktree("acme"), "/tmp/komnet-home/networks/acme/net");
    assert.equal(layout.roomWorktree("acme", ROOM), `/tmp/komnet-home/networks/acme/rooms/${ROOM}`);
    assert.equal(layout.socketPath, "/tmp/komnet-home/daemon.sock");
  });

  it("rejects an unsafe room id before it reaches the filesystem", () => {
    const layout = new Layout("/tmp/komnet-home");
    assert.throws(() => layout.roomWorktree("acme", "../escape"));
  });
});
