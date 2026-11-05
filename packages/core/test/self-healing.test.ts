/**
 * Regressions from a daemon that wedged for days without telling anyone.
 *
 * Observed on 2026-11-05 (komnet 1.0.0 under launchd): empty, days-old git lock
 * files with no git process alive; a seal-lock file left modified after a failed
 * commit, after which every sync failed with "cannot rebase: You have unstaged
 * changes"; an agent card left staged, after which the seal's merge into `main`
 * failed; and a seal retry loop that held the network lock across slow fetches
 * so that sync and `answer` starved. Each `describe` here pins one mechanism.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { roomRef } from "@komnet/protocol";

import { defaultIdentity } from "../src/config.ts";
import { GitError } from "../src/errors.ts";
import { GitRunner } from "../src/git/runner.ts";
import { Layout } from "../src/layout.ts";
import { FileLock } from "../src/lock.ts";
import { Network } from "../src/network.ts";
import type { RoomConfig } from "../src/room/config.ts";
import { Sealer, type SealPolicy } from "../src/seal/sealer.ts";

const exec = promisify(execFile);
const ROOM = "healing";
const NET = "healing-net";
const SELF = "healing-agent";
const POLICY: SealPolicy = {
  windowDays: 3650,
  windowMessages: 2,
  minIntervalHours: 0,
  lockLeaseMinutes: 15,
};

process.env["GIT_AUTHOR_NAME"] = "komnet healing test";
process.env["GIT_AUTHOR_EMAIL"] = "healing@komnet.invalid";
process.env["GIT_COMMITTER_NAME"] = "komnet healing test";
process.env["GIT_COMMITTER_EMAIL"] = "healing@komnet.invalid";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function porcelain(worktree: string): Promise<string> {
  const { stdout } = await exec("git", ["-C", worktree, "status", "--porcelain"]);
  return stdout.trim();
}

async function backdate(path: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  await utimes(path, when, when);
}

interface Fixture {
  root: string;
  remote: string;
  layout: Layout;
  network: Network;
  room: string;
  record: string;
  sealer: () => Sealer;
  send: (body: string) => Promise<string>;
  /** Shrink the room's retention so a handful of messages is due for sealing. */
  tightRetention: () => void;
  cleanup: () => Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "komnet-healing-"));
  const remote = join(root, "transport.git");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  const layout = new Layout(join(root, "home"));
  const { network } = await Network.init({
    layout,
    networkId: NET,
    remote,
    identity: defaultIdentity({ id: SELF }),
  });
  await network.createRoom(ROOM, { title: "Healing" });
  return {
    root,
    remote,
    layout,
    network,
    room: layout.roomWorktree(NET, ROOM),
    record: layout.recordWorktree(NET),
    sealer: () => new Sealer({ repo: network.repo, layout, networkId: NET, agentId: SELF, remote }),
    send: async (body) => (await network.send(ROOM, { body })).header.id,
    tightRetention: () => {
      const original = network.readRoomConfig.bind(network);
      network.readRoomConfig = async (roomId: string): Promise<RoomConfig | null> => {
        const config = await original(roomId);
        if (config === null) return null;
        return {
          ...config,
          retention: { windowDays: 3650, windowMessages: 2, sealMinIntervalHours: 0 },
        };
      };
    },
    cleanup: async () => {
      network.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

/**
 * Make one class of git command fail the way a stale lock or a killed process
 * makes it fail, leaving every other command (including any rollback) real.
 */
function failGit(
  network: Network,
  match: (args: readonly string[]) => boolean,
): { restore: () => void } {
  const runner = network.repo.runner;
  const original = runner.run.bind(runner);
  runner.run = async (args, options) => {
    if (match(args)) {
      throw new GitError({
        args: [...args],
        exitCode: 128,
        signal: null,
        stderr: "fatal: simulated failure",
        stdout: "",
        cwd: options.cwd,
      });
    }
    return await original(args, options);
  };
  return {
    restore: () => {
      runner.run = original;
    },
  };
}

const isCommit = (args: readonly string[]): boolean => args[0] === "commit";

// ---------------------------------------------------------------------------

describe("a timed-out git is asked to stop before it is killed", () => {
  it("lets git remove its own lock file instead of orphaning it", async () => {
    // SIGKILL cannot be trapped, so git's lockfile cleanup never ran: every
    // `add -A failed (SIGKILL)` in the daemon log left an empty index.lock that
    // blocked all later writes to that worktree.
    const dir = await mkdtemp(join(tmpdir(), "komnet-runner-kill-"));
    try {
      const fake = join(dir, "fake-git.sh");
      await writeFile(
        fake,
        [
          "#!/bin/sh",
          'for arg in "$@"; do',
          '  if [ "$arg" = "--version" ]; then echo "git version 2.99.0"; exit 0; fi',
          "done",
          'lock="$PWD/index.lock"',
          "trap 'kill $child 2>/dev/null; rm -f \"$lock\"; exit 143' TERM",
          ': > "$lock"',
          ': > "$PWD/started"',
          "sleep 20 &",
          "child=$!",
          'wait "$child"',
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(fake, 0o755);

      const runner = new GitRunner(fake, { killGraceMs: 5_000 });
      await assert.rejects(runner.run(["hang"], { cwd: dir, timeoutMs: 400 }));
      assert.equal(await pathExists(join(dir, "started")), true, "the fake git never ran");
      assert.equal(
        await pathExists(join(dir, "index.lock")),
        false,
        "a timed-out git must get SIGTERM first so its lockfile cleanup runs",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("stale git lock files", () => {
  async function repoWithFile(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "komnet-stale-lock-"));
    await exec("git", ["init", "--quiet", "--initial-branch=main", dir]);
    await writeFile(join(dir, "a.txt"), "one\n", "utf8");
    await exec("git", ["-C", dir, "add", "a.txt"]);
    await exec("git", ["-C", dir, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "a"]);
    await writeFile(join(dir, "a.txt"), "two\n", "utf8");
    return dir;
  }

  it("removes an old lock no process owns, says so, and completes the command", async () => {
    const dir = await repoWithFile();
    try {
      const lock = join(dir, ".git", "index.lock");
      await writeFile(lock, "", "utf8");
      await backdate(lock, 60 * 60_000);

      const lines: string[] = [];
      const runner = new GitRunner("git", { log: (line) => lines.push(line) });
      await runner.run(["add", "--", "a.txt"], { cwd: dir });

      assert.equal(await pathExists(lock), false);
      assert.ok(
        lines.some((line) => line.includes("index.lock")),
        `the removal must be logged, got: ${JSON.stringify(lines)}`,
      );
      const { stdout } = await exec("git", ["-C", dir, "diff", "--cached", "--name-only"]);
      assert.equal(stdout.trim(), "a.txt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves a fresh lock alone — it may belong to a git that is still running", async () => {
    const dir = await repoWithFile();
    try {
      const lock = join(dir, ".git", "index.lock");
      await writeFile(lock, "", "utf8");

      const runner = new GitRunner("git");
      await assert.rejects(runner.run(["add", "--", "a.txt"], { cwd: dir }), /index\.lock/);
      assert.equal(await pathExists(lock), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the network lock", () => {
  async function lockDir(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "komnet-filelock-"));
  }

  it("is never stolen from a live holder on this machine, however long it is held", async () => {
    // A seal held this lock longer than the 5-minute staleness window, sync
    // stole it, and two writers ran git in the same worktree at once.
    const dir = await lockDir();
    try {
      const path = join(dir, "lock");
      await writeFile(
        path,
        JSON.stringify({
          pid: process.pid,
          host: hostname(),
          acquiredAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        }),
        "utf8",
      );
      await assert.rejects(FileLock.acquire(path, { timeoutMs: 400 }), /timed out/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats a holder recorded before this machine booted as gone, even if its pid is reused", async () => {
    const dir = await lockDir();
    try {
      const path = join(dir, "lock");
      const beforeBoot = Date.now() - uptime() * 1000 - 60 * 60_000;
      await writeFile(
        path,
        JSON.stringify({
          pid: process.pid,
          host: hostname(),
          acquiredAt: new Date(beforeBoot).toISOString(),
        }),
        "utf8",
      );
      const lock = await FileLock.acquire(path, { timeoutMs: 2_000 });
      await lock.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not steal a lock file that another process created a moment ago", async () => {
    // `wx` creates the file empty and the record is written right after; a
    // reader in between saw "unparseable" and deleted a lock that was live.
    const dir = await lockDir();
    try {
      const path = join(dir, "lock");
      await writeFile(path, "", "utf8");
      await assert.rejects(FileLock.acquire(path, { timeoutMs: 400 }), /timed out/);

      await backdate(path, 60_000);
      const lock = await FileLock.acquire(path, { timeoutMs: 2_000 });
      await lock.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a failed write leaves no debris in the transport worktree", () => {
  it("rolls back an agent card whose commit failed", async () => {
    const f = await fixture();
    try {
      const fault = failGit(f.network, isCommit);
      await assert.rejects(f.network.publishAgentCard({ expertise: ["rollback-check"] }));
      fault.restore();
      assert.equal(await porcelain(f.record), "", "the card must not be left staged");
    } finally {
      await f.cleanup();
    }
  });

  it("rolls back a message whose commit failed", async () => {
    const f = await fixture();
    try {
      const fault = failGit(f.network, isCommit);
      await assert.rejects(f.network.send(ROOM, { body: "never committed" }));
      fault.restore();
      assert.equal(await porcelain(f.room), "", "the message file must not be left behind");
      await f.send("the next send still works");
      assert.equal(await porcelain(f.room), "");
    } finally {
      await f.cleanup();
    }
  });
});

/**
 * A room whose branch already tracks a seal-lock file, a peer that can ask us
 * something, and a scratch clone for moving the remote's lock on.
 */
async function lockedRoom(f: Fixture): Promise<{
  peer: Network;
  lockRecord: (holder: string) => string;
  moveRemoteLock: (holder: string) => Promise<void>;
}> {
  const { network: peer } = await Network.init({
    layout: new Layout(join(f.root, "peer")),
    networkId: NET,
    remote: f.remote,
    identity: defaultIdentity({ id: "peer-agent" }),
  });
  await peer.joinRoom(ROOM);

  const clone = join(f.root, "clone");
  await exec("git", ["clone", "--quiet", "--branch", roomRef(ROOM), f.remote, clone]);
  await mkdir(join(clone, "rooms", ROOM, ".seal"), { recursive: true });
  const lockRecord = (holder: string) =>
    `${JSON.stringify({
      v: 2,
      holder,
      token: holder,
      acquired_at: new Date().toISOString(),
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    })}\n`;
  const moveRemoteLock = async (holder: string) => {
    await exec("git", ["-C", clone, "pull", "--quiet", "--rebase", "origin", roomRef(ROOM)]);
    await writeFile(join(clone, "rooms", ROOM, ".seal", "lock.json"), lockRecord(holder), "utf8");
    await exec("git", ["-C", clone, "add", "-A"]);
    await exec("git", [
      "-C",
      clone,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      `lock for ${holder}`,
    ]);
    await exec("git", ["-C", clone, "push", "--quiet", "origin", `HEAD:${roomRef(ROOM)}`]);
  };

  await moveRemoteLock("first-sealer");
  await f.network.sync();
  return { peer, lockRecord, moveRemoteLock };
}

describe("sync recovers a worktree an interrupted write left dirty", () => {
  it("delivers new messages despite a modified seal-lock file", async () => {
    const f = await fixture();
    let peer: Network | null = null;
    try {
      const room = await lockedRoom(f);
      peer = room.peer;

      // The failed acquire: our lock record written, its commit never made.
      await writeFile(
        join(f.room, "rooms", ROOM, ".seal", "lock.json"),
        room.lockRecord(SELF),
        "utf8",
      );
      assert.notEqual(await porcelain(f.room), "");

      // Meanwhile the room moves on: another sealer, and a question for us.
      await room.moveRemoteLock("second-sealer");
      await peer.send(ROOM, { body: "are you there?", mentions: [SELF] });

      const report = await f.network.sync();
      assert.ok(
        report.deliveredMessages.some((message) => message.header.from === "peer-agent"),
        "the peer's question must be delivered",
      );
      assert.equal(await porcelain(f.room), "");
      assert.equal(f.network.health().degraded, false);
    } finally {
      peer?.close();
      await f.cleanup();
    }
  });

  it("delivers past a seal commit a dead sealer committed but never pushed", async () => {
    // Killed between its commit and its push, a sealer leaves a local lock
    // commit. Once the remote's lock moves on, neither the outbox push nor the
    // room's fast-forward can rebase it, and every sync fails from then on.
    const f = await fixture();
    let peer: Network | null = null;
    try {
      const room = await lockedRoom(f);
      peer = room.peer;

      await writeFile(
        join(f.room, "rooms", ROOM, ".seal", "lock.json"),
        room.lockRecord(SELF),
        "utf8",
      );
      await exec("git", ["-C", f.room, "add", "-A"]);
      await exec("git", [
        "-C",
        f.room,
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "komnet: acquire seal lock (never pushed)",
      ]);

      await room.moveRemoteLock("second-sealer");
      await peer.send(ROOM, { body: "still there?", mentions: [SELF] });

      const report = await f.network.sync();
      assert.ok(
        report.deliveredMessages.some((message) => message.header.from === "peer-agent"),
        "the peer's question must be delivered",
      );
      assert.equal(
        await f.network.repo.aheadCount(f.room, `refs/remotes/origin/${roomRef(ROOM)}`),
        0,
        "the dead sealer's lock must not stay queued for an ordinary push",
      );
      assert.ok(report.repaired.length > 0, "the repair must be reported");
    } finally {
      peer?.close();
      await f.cleanup();
    }
  });
});

describe("a write publishes only what it wrote", () => {
  async function headFiles(worktree: string): Promise<string[]> {
    const { stdout } = await exec("git", [
      "-C",
      worktree,
      "show",
      "--name-only",
      "--format=",
      "HEAD",
    ]);
    return stdout.split("\n").filter((line) => line.length > 0);
  }

  it("leaves debris staged beside a message out of the message's commit", async () => {
    // `git commit` with no pathspec commits the whole index, so a staged
    // `lock.json` left by a dead sealer was published inside an ordinary
    // message — a seal lock that never went through compare-and-swap.
    const f = await fixture();
    try {
      await mkdir(join(f.room, "rooms", ROOM, ".seal"), { recursive: true });
      await writeFile(join(f.room, "rooms", ROOM, ".seal", "lock.json"), "{}\n", "utf8");
      await exec("git", ["-C", f.room, "add", "-A"]);

      await f.send("only this message");
      const files = await headFiles(f.room);
      assert.equal(files.length, 1, JSON.stringify(files));
      assert.match(files[0] ?? "", /\/msg\//);
    } finally {
      await f.cleanup();
    }
  });

  it("leaves debris staged beside an agent card out of the card's commit", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.record, "stray.txt"), "left behind\n", "utf8");
      await exec("git", ["-C", f.record, "add", "-A"]);

      await f.network.publishAgentCard({ expertise: ["pathspec-check"] });
      assert.deepEqual(await headFiles(f.record), [`agents/${SELF}.yaml`]);
    } finally {
      await f.cleanup();
    }
  });
});

describe("sealing never wedges on its own debris", () => {
  it("completes with an agent card left staged in the record worktree", async () => {
    // `git merge` refuses ANY non-fast-forward merge while the index differs
    // from HEAD (exit 2, "would be overwritten by merge"), so one staged card
    // blocked every seal of every room.
    const f = await fixture();
    try {
      for (const body of ["one", "two", "three", "four"]) await f.send(body);
      const card = join(f.record, "agents", `${SELF}.yaml`);
      await writeFile(card, `${await readFile(card, "utf8")}# interrupted write\n`, "utf8");
      await exec("git", ["-C", f.record, "add", "--", `agents/${SELF}.yaml`]);

      const result = await f.sealer().seal(ROOM, POLICY);
      assert.equal(result.sealed, 2);
      assert.equal(await porcelain(f.record), "");
    } finally {
      await f.cleanup();
    }
  });

  it("rolls back a seal lock whose commit failed", async () => {
    const f = await fixture();
    try {
      for (const body of ["one", "two", "three", "four"]) await f.send(body);
      const fault = failGit(f.network, isCommit);
      await assert.rejects(f.sealer().seal(ROOM, POLICY));
      fault.restore();
      assert.equal(await porcelain(f.room), "", "lock.json must not be left modified");
    } finally {
      await f.cleanup();
    }
  });

  it("does not keep a lock commit that never reached the remote", async () => {
    const f = await fixture();
    try {
      for (const body of ["one", "two", "three", "four"]) await f.send(body);
      const original = f.network.repo.pushCompareAndSwap.bind(f.network.repo);
      f.network.repo.pushCompareAndSwap = async () => {
        throw new Error("simulated transport outage");
      };
      await assert.rejects(f.sealer().seal(ROOM, POLICY), /transport outage/);
      f.network.repo.pushCompareAndSwap = original;

      const ahead = await f.network.repo.aheadCount(f.room, `refs/remotes/origin/${roomRef(ROOM)}`);
      assert.equal(ahead, 0, "an unpublished lock commit would be pushed by the next sync");
      assert.equal(await porcelain(f.room), "");
    } finally {
      await f.cleanup();
    }
  });

  it("decides lock ownership from the remote, not from a local commit that never landed", async () => {
    // The daemon logged "seal lock for general was lost before compaction
    // completed" for days: acquire resumed a lock it found in the LOCAL
    // worktree, renew then checked the REMOTE and found someone else's.
    const f = await fixture();
    try {
      for (const body of ["one", "two", "three", "four"]) await f.send(body);

      // Leave a pending transaction on the remote: fail after it was planned.
      const push = f.network.repo.pushPreservingMerges.bind(f.network.repo);
      f.network.repo.pushPreservingMerges = async (worktree, branch, options) => {
        if (branch === "main") throw new Error("simulated main outage");
        return await push(worktree, branch, options);
      };
      await assert.rejects(f.sealer().seal(ROOM, POLICY), /main outage/);
      f.network.repo.pushPreservingMerges = push;

      // A lock of ours committed locally and never pushed.
      const lockPath = join(f.room, "rooms", ROOM, ".seal", "lock.json");
      await writeFile(
        lockPath,
        `${JSON.stringify({
          v: 2,
          holder: SELF,
          token: "never-published",
          acquired_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        })}\n`,
        "utf8",
      );
      await exec("git", ["-C", f.room, "add", "-A"]);
      await exec("git", [
        "-C",
        f.room,
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "local-only lock",
      ]);

      const result = await f.sealer().seal(ROOM, POLICY);
      assert.equal(result.sealed, 2);
    } finally {
      await f.cleanup();
    }
  });
});

describe("sealing shares the network lock", () => {
  it("does not hold it across fetches, so a send goes through mid-seal", async () => {
    const f = await fixture();
    try {
      for (const body of ["one", "two", "three", "four"]) await f.send(body);
      f.tightRetention();
      const lockPath = join(f.layout.networkDir(NET), "lock");

      const heldDuringFetch: boolean[] = [];
      let sending = false;
      let entered: () => void = () => undefined;
      const firstFetch = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const fetch = f.network.repo.fetch.bind(f.network.repo);
      f.network.repo.fetch = async (remote, refspecs) => {
        if (!sending) heldDuringFetch.push(await pathExists(lockPath));
        entered();
        await sleep(700);
        return await fetch(remote, refspecs);
      };

      let sealFinished = false;
      const sealing = f.network.seal(ROOM).then((result) => {
        sealFinished = true;
        return result;
      });
      await firstFetch;
      sending = true;
      await f.send("sent while the seal was fetching");
      sending = false;
      const finishedFirst = sealFinished;
      const result = await sealing;
      f.network.repo.fetch = fetch;

      assert.equal(finishedFirst, false, "the send waited for the whole seal");
      assert.deepEqual(
        heldDuringFetch.filter((held) => held),
        [],
        "the seal held the network lock across a fetch",
      );
      assert.ok(result.sealed >= 2, JSON.stringify(result));
    } finally {
      await f.cleanup();
    }
  });

  it("backs off a failing seal instead of retrying it after every sync", async () => {
    const f = await fixture();
    try {
      for (const body of ["one", "two", "three", "four"]) await f.send(body);
      f.tightRetention();
      assert.ok((await f.network.roomsNeedingSeal()).some((due) => due.roomId === ROOM));

      const original = f.network.repo.pushCompareAndSwap.bind(f.network.repo);
      f.network.repo.pushCompareAndSwap = async () => {
        throw new Error("simulated transport outage");
      };
      await assert.rejects(f.network.seal(ROOM), /transport outage/);
      f.network.repo.pushCompareAndSwap = original;

      assert.equal(
        (await f.network.roomsNeedingSeal()).some((due) => due.roomId === ROOM),
        false,
        "a seal that just failed must wait before the automatic retry",
      );
      // An explicit request is not throttled, and success clears the backoff.
      const result = await f.network.seal(ROOM);
      assert.ok(result.sealed >= 2, JSON.stringify(result));
    } finally {
      await f.cleanup();
    }
  });
});
