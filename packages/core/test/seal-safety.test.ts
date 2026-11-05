import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { createMessage, messagePath, roomRef, ulid, type Message } from "@komnet/protocol";

import { defaultIdentity } from "../src/config.ts";
import { GitError } from "../src/errors.ts";
import { Layout } from "../src/layout.ts";
import { Network } from "../src/network.ts";
import { RoomStore } from "../src/room/store.ts";
import { Sealer, type SealPolicy } from "../src/seal/sealer.ts";

const exec = promisify(execFile);
const ROOM = "safety";
const POLICY: SealPolicy = {
  windowDays: 3650,
  windowMessages: 2,
  minIntervalHours: 0,
  lockLeaseMinutes: 15,
};

process.env["GIT_AUTHOR_NAME"] = "komnet safety test";
process.env["GIT_AUTHOR_EMAIL"] = "safety@komnet.invalid";
process.env["GIT_COMMITTER_NAME"] = "komnet safety test";
process.env["GIT_COMMITTER_EMAIL"] = "safety@komnet.invalid";

interface Fixture {
  tmp: string;
  remote: string;
  layout: Layout;
  network: Network;
  sealer: () => Sealer;
  send: (body: string, input?: Parameters<Network["send"]>[1]) => Promise<string>;
  cleanup: () => Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "komnet-seal-safety-"));
  const remote = join(root, "transport.git");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  const layout = new Layout(join(root, "home"));
  const initialized = await Network.init({
    layout,
    networkId: "safety-net",
    remote,
    identity: defaultIdentity({ id: "safety-agent" }),
  });
  const network = initialized.network;
  await network.createRoom(ROOM, { title: "Safety" });
  return {
    tmp: root,
    remote,
    layout,
    network,
    sealer: () =>
      new Sealer({
        repo: network.repo,
        layout,
        networkId: "safety-net",
        agentId: "safety-agent",
        remote,
      }),
    send: async (body, input = { body }) => {
      const message = await network.send(ROOM, { ...input, body });
      return message.header.id;
    },
    cleanup: async () => {
      network.close();
      // Retries, like every other suite here. Sealing runs `git gc`/`repack`,
      // which can still be writing into `objects/pack` when this fires, and a
      // plain recursive remove then fails with ENOTEMPTY — observed on macOS CI
      // while the test itself had already passed. This was the one fixture in
      // the repository missing the retry, so it was the one that flaked.
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decision bodies long enough that the promoted record is more than 50%
 * similar to its source message — the threshold at which git's rename
 * detection pairs the two. Live decisions are this long (R082 and R088 on
 * `lookstream-ai-talks`, 2026-09-19); a one-line body stays below it.
 */
const RETRY_DECISION = [
  "Retry budget: three client retries, no server-side replay",
  "",
  "Decided after the payments incident review:",
  "",
  "- Clients retry an idempotent write at most three times, with full-jitter backoff.",
  "- The server never replays a write on a client's behalf; a lost acknowledgement",
  "  is resolved by the idempotency key, not by a second write.",
  "- Non-idempotent writes are never retried automatically; the caller surfaces the failure.",
  "- The budget is revisited when the queue moves to the new broker, not before.",
].join("\n");

const OWNERSHIP_DECISION = [
  "Ownership: the ledger team owns refunds end to end",
  "",
  "Agreed between the ledger and checkout owners:",
  "",
  "- Refund initiation, reversal and reconciliation live in the ledger service.",
  "- Checkout emits the order facts and never writes a refund row itself.",
  "- A refund that cannot reconcile within a day pages the ledger on-call, not checkout.",
  "- The contract change is versioned; checkout keeps the old field until the next release.",
].join("\n");

async function remoteGit(remote: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", ["--git-dir", remote, ...args]);
  return stdout.trim();
}

/** The message as `main` still holds it in history, or null if it became unreachable. */
async function sealedOnMain(remote: string, message: Message): Promise<string | null> {
  const path = messagePath(message.header);
  const commit = await remoteGit(remote, [
    "log",
    "-1",
    "--format=%H",
    "--diff-filter=A",
    "main",
    "--",
    path,
  ]);
  if (commit === "") return null;
  return await remoteGit(remote, ["show", `${commit}:${path}`]);
}

/** Every file in the room's decisions directory on the remote `main`, by name. */
async function decisionsOnMain(remote: string): Promise<Map<string, string>> {
  const dir = `rooms/${ROOM}/decisions/`;
  const names = (await remoteGit(remote, ["ls-tree", "--name-only", "main", dir]))
    .split("\n")
    .filter((line) => line.length > 0);
  const decisions = new Map<string, string>();
  for (const path of names) {
    decisions.set(path.slice(dir.length), await remoteGit(remote, ["show", `main:${path}`]));
  }
  return decisions;
}

describe("sealing safety invariants", () => {
  it("does not disguise an arbitrary remote rejection as a lock race", () => {
    const rejected = new GitError({
      args: ["push"],
      exitCode: 1,
      signal: null,
      stderr: "! [remote rejected] room/safety -> room/safety (pre-receive hook declined)",
      stdout: "",
      cwd: "/tmp",
    });
    assert.equal(rejected.isNonFastForward, false);

    const raced = new GitError({
      args: ["push"],
      exitCode: 1,
      signal: null,
      stderr: "! [rejected] room/safety -> room/safety (fetch first)",
      stdout: "",
      cwd: "/tmp",
    });
    assert.equal(raced.isNonFastForward, true);
  });

  it("uses chronology rather than thread display order for the count boundary", async () => {
    const f = await fixture();
    try {
      const root = await f.send("old root");
      const middle = await f.send("middle");
      const reply = await f.send("new reply", { body: "new reply", inReplyTo: root });
      const latest = await f.send("latest");

      const decision = await f.sealer().decide(ROOM, POLICY);
      assert.deepEqual(
        decision.toSeal.map((message) => message.header.id),
        [root, middle],
      );
      assert.equal(
        decision.toSeal.some((message) => message.header.id === reply),
        false,
      );
      assert.equal(
        decision.toSeal.some((message) => message.header.id === latest),
        false,
      );
    } finally {
      await f.cleanup();
    }
  });

  it("keeps unresolved needs items as raw live messages even above the cap", async () => {
    const f = await fixture();
    try {
      const parent = await f.send("Migration context");
      const question = await f.send("Who approves the migration?", {
        body: "Who approves the migration?",
        kind: "question",
        needs: "human",
        inReplyTo: parent,
      });
      await f.send("one");
      await f.send("two");
      await f.send("three");

      const decision = await f.sealer().decide(ROOM, { ...POLICY, windowMessages: 1 });
      assert.equal(decision.preserved, 2);
      assert.equal(
        decision.toSeal.some((message) => message.header.id === question),
        false,
      );
      assert.equal(
        decision.toSeal.some((message) => message.header.id === parent),
        false,
      );

      const result = await f.sealer().seal(ROOM, { ...POLICY, windowMessages: 1 });
      assert.equal(result.sealed, 2);
      const live = await new RoomStore(f.layout.roomWorktree("safety-net", ROOM), ROOM).readAll();
      assert.ok(live.some((message) => message.header.id === question));
      assert.ok(live.some((message) => message.header.id === parent));

      const digest = await readFile(
        join(f.layout.recordWorktree("safety-net"), result.digest as string),
        "utf8",
      );
      assert.match(digest, new RegExp(question));
      assert.match(digest, /Carried forward/);
    } finally {
      await f.cleanup();
    }
  });

  it("protects active review chains but releases terminal reviews to compaction", async () => {
    const f = await fixture();
    let peer: Network | undefined;
    try {
      peer = (
        await Network.init({
          layout: new Layout(join(f.tmp, "peer")),
          networkId: "safety-net",
          remote: f.remote,
          identity: defaultIdentity({ id: "peer-reviewer" }),
        })
      ).network;
      await peer.joinRoom(ROOM);

      const request = await f.network.requestReview(ROOM, {
        reviewer: "peer-reviewer",
        repo: "github.com/acme/payments",
        baseRev: "1".repeat(40),
        headRev: "2".repeat(40),
        summary: "Review payment idempotency.",
      });
      const reviewId = request.header.review?.id as string;
      await peer.sync();
      const reported = await peer.updateReview(ROOM, reviewId, {
        state: "reported",
        body: "One concrete retry race needs requester confirmation.",
      });
      await f.network.sync();
      for (const body of ["filler one", "filler two", "filler three"]) await f.send(body);

      const active = await f.sealer().decide(ROOM, { ...POLICY, windowMessages: 1 });
      const activeIds = new Set(active.toSeal.map((message) => message.header.id));
      assert.equal(activeIds.has(request.header.id), false);
      assert.equal(activeIds.has(reported.header.id), false);
      assert.equal(active.preserved, 2);

      const completed = await f.network.updateReview(ROOM, reviewId, {
        state: "completed",
        body: "Confirmed against the caller; the review is resolved.",
      });
      for (const body of ["later one", "later two", "later three"]) await f.send(body);

      const terminal = await f.sealer().decide(ROOM, { ...POLICY, windowMessages: 1 });
      const terminalIds = new Set(terminal.toSeal.map((message) => message.header.id));
      assert.ok(terminalIds.has(request.header.id));
      assert.ok(terminalIds.has(reported.header.id));
      assert.ok(terminalIds.has(completed.header.id));
    } finally {
      peer?.close();
      await f.cleanup();
    }
  });

  it("re-decides under the lock instead of replaying a stale boundary", async () => {
    const f = await fixture();
    try {
      await f.send("one");
      await f.send("two");
      await f.send("three");
      await f.send("four");

      const winner = f.sealer();
      const stale = f.sealer();
      type Internals = {
        acquireLock: (roomId: string, policy: SealPolicy) => Promise<unknown>;
      };
      const internals = stale as unknown as Internals;
      const acquire = internals.acquireLock.bind(stale);
      const winnerResults: Awaited<ReturnType<Sealer["seal"]>>[] = [];
      internals.acquireLock = async (roomId, policy) => {
        winnerResults.push(await winner.seal(roomId, policy));
        return await acquire(roomId, policy);
      };

      const staleResult = await stale.seal(ROOM, POLICY);
      assert.equal(winnerResults[0]?.sealed, 2);
      assert.equal(staleResult.sealed, 0);
      assert.ok(staleResult.skipped);
      const digests = await readdir(
        join(f.layout.recordWorktree("safety-net"), "rooms", ROOM, "digest"),
      );
      assert.equal(
        digests.length,
        1,
        "a stale pre-lock decision must not create a duplicate digest",
      );
    } finally {
      await f.cleanup();
    }
  });

  it("uses deterministic batch paths for repeated seals in one month", async () => {
    const f = await fixture();
    try {
      for (const body of ["one", "two", "three", "four"]) await f.send(body);
      const first = await f.sealer().seal(ROOM, POLICY);
      assert.equal(first.sealed, 2);
      await f.send("five");
      await f.send("six");
      const second = await f.sealer().seal(ROOM, POLICY);
      assert.equal(second.sealed, 2);

      const record = f.layout.recordWorktree("safety-net");
      const digests = await readdir(join(record, "rooms", ROOM, "digest"));
      assert.equal(digests.length, 2);
      for (const name of digests) {
        assert.match(name, /^\d{4}-\d{2}-[0-9a-f]{16}\.md$/);
      }
      assert.equal(
        await pathExists(join(record, "rooms", ROOM, ".seal", "lock.json")),
        false,
        "ephemeral lock state must not leak into main's tree",
      );
    } finally {
      await f.cleanup();
    }
  });

  it("writes one deterministic digest per UTC month in a spanning transaction", async () => {
    const f = await fixture();
    try {
      const room = f.layout.roomWorktree("safety-net", ROOM);
      const store = new RoomStore(room, ROOM);
      for (const ts of [
        "2026-01-01T10:00:00.000Z",
        "2026-01-02T10:00:00.000Z",
        "2026-02-01T10:00:00.000Z",
      ]) {
        await store.writeMessage(
          createMessage({
            id: ulid(Date.parse(ts)),
            room: ROOM,
            from: "safety-agent",
            authorKind: "agent",
            kind: "msg",
            needs: "none",
            body: `${ts}\n`,
            ts,
          }),
        );
      }
      await f.network.repo.commitAll(room, "historical messages");
      await f.network.repo.pushWithRetry(room, roomRef(ROOM), { sleep: async () => {} });
      await f.send("current");

      const result = await f.sealer().seal(ROOM, { ...POLICY, windowMessages: 1 });
      assert.equal(result.sealed, 3);
      assert.equal(result.digests.length, 2);
      assert.ok(result.digests.some((path) => /2026-01-[0-9a-f]{16}\.md$/.test(path)));
      assert.ok(result.digests.some((path) => /2026-02-[0-9a-f]{16}\.md$/.test(path)));
    } finally {
      await f.cleanup();
    }
  });

  it("resumes after the room push acknowledgement is lost without duplicating records", async () => {
    const f = await fixture();
    try {
      await f.send("Decision title\n\nDecision body", {
        body: "Decision title\n\nDecision body",
        kind: "decision",
        needs: "none",
      });
      await f.send("two");
      await f.send("three");
      await f.send("four");

      const original = f.network.repo.pushPreservingMerges.bind(f.network.repo);
      let mainDurable = false;
      let injected = false;
      f.network.repo.pushPreservingMerges = async (worktree, branch, options) => {
        const result = await original(worktree, branch, options);
        if (branch === "main") mainDurable = true;
        if (branch === roomRef(ROOM) && mainDurable && !injected) {
          injected = true;
          throw new Error("simulated lost prune-push acknowledgement");
        }
        return result;
      };

      await assert.rejects(f.sealer().seal(ROOM, POLICY), /lost prune-push acknowledgement/);
      f.network.repo.pushPreservingMerges = original;

      f.network.state.setMeta(`lastSealAt:${ROOM}`, new Date().toISOString());
      const due = await f.network.roomsNeedingSeal();
      assert.equal(
        due.some((decision) => decision.roomId === ROOM),
        true,
      );
      assert.match(due.find((decision) => decision.roomId === ROOM)?.reason ?? "", /pending/);

      const retried = await f.sealer().seal(ROOM, POLICY);
      assert.equal(retried.sealed, 2);
      const record = f.layout.recordWorktree("safety-net");
      assert.equal((await readdir(join(record, "rooms", ROOM, "digest"))).length, 1);
      assert.equal((await readdir(join(record, "rooms", ROOM, "decisions"))).length, 1);
      assert.equal(
        await pathExists(
          join(
            f.layout.roomWorktree("safety-net", ROOM),
            "rooms",
            ROOM,
            ".seal",
            "transaction.json",
          ),
        ),
        false,
      );
    } finally {
      await f.cleanup();
    }
  });

  /**
   * The state every later seal of a room starts from once one seal promoted a
   * decision: `main` merged the room, recorded the decision and dropped the raw
   * message, and the room pruned it. The next seal merges the room again from
   * that merge base, where the room deleted the source and `main` "renamed" it
   * to the decision record — `lookstream-ai-talks/general`, failing every
   * retry from 2026-09-19 with `CONFLICT (rename/delete)`.
   */
  async function sealADecisionThenGrow(f: Fixture): Promise<{
    firstBatch: Message[];
    firstDecisions: Map<string, string>;
    secondBatch: Message[];
    secondDecisionId: string;
  }> {
    await f.send(RETRY_DECISION, { body: RETRY_DECISION, kind: "decision", needs: "none" });
    await f.send("two");
    const secondDecisionId = await f.send(OWNERSHIP_DECISION, {
      body: OWNERSHIP_DECISION,
      kind: "decision",
      needs: "none",
    });
    await f.send("four");

    const firstBatch = (await f.sealer().decide(ROOM, POLICY)).toSeal;
    const first = await f.sealer().seal(ROOM, POLICY);
    assert.equal(first.sealed, 2);
    assert.equal(first.decisionsPromoted, 1);
    const firstDecisions = await decisionsOnMain(f.remote);
    assert.equal(firstDecisions.size, 1);

    // Precondition, so this cannot pass vacuously: git does pair the pruned
    // source message with its decision record across the next merge base.
    const base = await remoteGit(f.remote, ["merge-base", "main", roomRef(ROOM)]);
    const renamed = await remoteGit(f.remote, [
      "diff",
      "--find-renames",
      "--diff-filter=R",
      "--name-only",
      base,
      "main",
    ]);
    assert.match(renamed, new RegExp(`^rooms/${ROOM}/decisions/0001-`, "m"));

    await f.send("five");
    await f.send("six");
    const secondBatch = (await f.sealer().decide(ROOM, POLICY)).toSeal;
    assert.ok(secondBatch.some((message) => message.header.id === secondDecisionId));
    return { firstBatch, firstDecisions, secondBatch, secondDecisionId };
  }

  async function assertNothingLost(
    f: Fixture,
    sealed: readonly Message[],
    firstDecisions: ReadonlyMap<string, string>,
    secondDecisionId: string,
  ): Promise<void> {
    for (const message of sealed) {
      const held = await sealedOnMain(f.remote, message);
      assert.ok(held !== null, `sealed message ${message.header.id} is unreachable from main`);
      assert.match(held, new RegExp(`^id: ${message.header.id}$`, "m"));
    }

    const decisions = await decisionsOnMain(f.remote);
    assert.equal(decisions.size, firstDecisions.size + 1);
    for (const [name, content] of firstDecisions) {
      assert.equal(decisions.get(name), content, `decision ${name} changed or vanished`);
    }
    const promoted = [...decisions].filter(([name]) => !firstDecisions.has(name));
    assert.equal(promoted.length, 1);
    assert.match(promoted[0]?.[0] ?? "", /^0002-/);
    assert.match(promoted[0]?.[1] ?? "", new RegExp(`^source_message: ${secondDecisionId}$`, "m"));

    const raw = await remoteGit(f.remote, [
      "ls-tree",
      "-r",
      "--name-only",
      "main",
      `rooms/${ROOM}`,
    ]);
    assert.doesNotMatch(raw, /\/msg\/|\/\.seal\//, "main must hold no raw messages or seal state");

    const live = await new RoomStore(f.layout.roomWorktree("safety-net", ROOM), ROOM).readAll();
    assert.deepEqual(live.map((message) => message.body.trim()).sort(), ["five", "six"]);
    const roomTree = await remoteGit(f.remote, ["ls-tree", "-r", "--name-only", roomRef(ROOM)]);
    assert.doesNotMatch(roomTree, /\/\.seal\//, "the room must be left with no seal in flight");
  }

  it("seals again after an earlier seal promoted a decision and pruned its source", async () => {
    const f = await fixture();
    try {
      const { firstBatch, firstDecisions, secondBatch, secondDecisionId } =
        await sealADecisionThenGrow(f);

      const second = await f.sealer().seal(ROOM, POLICY);
      assert.equal(second.sealed, 2);
      assert.equal(second.decisionsPromoted, 1);
      await assertNothingLost(f, [...firstBatch, ...secondBatch], firstDecisions, secondDecisionId);
    } finally {
      await f.cleanup();
    }
  });

  it("resumes a pending seal whose merge failed after an earlier decision promotion", async () => {
    const f = await fixture();
    try {
      const { firstBatch, firstDecisions, secondBatch, secondDecisionId } =
        await sealADecisionThenGrow(f);

      // Leave the live state: a transaction planned and pushed on the room, its
      // merge into `main` failed and rolled back.
      const repo = f.network.repo;
      const original = repo.merge.bind(repo);
      repo.merge = async (worktree, ref, options) => {
        if (ref === roomRef(ROOM)) throw new Error("simulated seal merge failure");
        return await original(worktree, ref, options);
      };
      const mainBefore = await remoteGit(f.remote, ["rev-parse", "main"]);
      await assert.rejects(f.sealer().seal(ROOM, POLICY), /simulated seal merge failure/);
      repo.merge = original;
      assert.equal(await f.sealer().hasPendingTransaction(ROOM), true);
      assert.equal(await remoteGit(f.remote, ["rev-parse", "main"]), mainBefore);

      const resumed = await f.sealer().seal(ROOM, POLICY);
      assert.equal(resumed.sealed, 2);
      assert.equal(resumed.decisionsPromoted, 1);
      assert.equal(await f.sealer().hasPendingTransaction(ROOM), false);
      await assertNothingLost(f, [...firstBatch, ...secondBatch], firstDecisions, secondDecisionId);
    } finally {
      await f.cleanup();
    }
  });

  it("never releases a successor's lock after losing ownership", async () => {
    const f = await fixture();
    try {
      type Internals = {
        acquireLock: (roomId: string, policy: SealPolicy) => Promise<object | null>;
        releaseLock: (roomId: string, held: object, clearTransaction: boolean) => Promise<void>;
      };
      const internals = f.sealer() as unknown as Internals;
      const held = await internals.acquireLock(ROOM, POLICY);
      assert.ok(held);

      const peer = join(f.tmp, "successor");
      await exec("git", ["clone", "--quiet", "--branch", roomRef(ROOM), f.remote, peer]);
      const lockPath = join(peer, "rooms", ROOM, ".seal", "lock.json");
      const successor = {
        v: 2,
        holder: "successor-agent",
        token: "successor-token",
        acquired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 900_000).toISOString(),
      };
      await writeFile(lockPath, `${JSON.stringify(successor, null, 2)}\n`, "utf8");
      await exec("git", ["-C", peer, "add", "-A"]);
      await exec("git", [
        "-C",
        peer,
        "-c",
        "commit.gpgSign=false",
        "commit",
        "--quiet",
        "-m",
        "successor owns lock",
      ]);
      await exec("git", ["-C", peer, "push", "--quiet", "origin", `HEAD:${roomRef(ROOM)}`]);

      await internals.releaseLock(ROOM, held, false);
      const { stdout } = await exec("git", [
        "--git-dir",
        f.remote,
        "show",
        `${roomRef(ROOM)}:rooms/${ROOM}/.seal/lock.json`,
      ]);
      assert.equal((JSON.parse(stdout) as { token: string }).token, "successor-token");
    } finally {
      await f.cleanup();
    }
  });
});
