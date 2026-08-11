import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { roomRef } from "@komnet/protocol";

import { Layout } from "../src/layout.ts";
import { Network } from "../src/network.ts";
import { RoomStore } from "../src/room/store.ts";
import { Sealer, type SealPolicy } from "../src/seal/sealer.ts";
import { defaultIdentity } from "../src/config.ts";

const exec = promisify(execFile);

process.env["GIT_AUTHOR_NAME"] = "komnet test";
process.env["GIT_AUTHOR_EMAIL"] = "test@komnet.invalid";
process.env["GIT_COMMITTER_NAME"] = "komnet test";
process.env["GIT_COMMITTER_EMAIL"] = "test@komnet.invalid";

const ROOM = "architecture";

/** Tight window so a handful of messages is enough to trigger a seal. */
const TIGHT: SealPolicy = {
  windowDays: 3650,
  windowMessages: 3,
  minIntervalHours: 0,
  lockLeaseMinutes: 15,
};

let tmp: string;
let remote: string;
let network: Network;
let layout: Layout;

async function send(body: string, kind: "msg" | "decision" = "msg"): Promise<string> {
  const message = await network.send(ROOM, { body, kind, needs: "none" });
  return message.header.id;
}

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "komnet-seal-"));
  remote = join(tmp, "transport.git");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);

  layout = new Layout(join(tmp, "home"));
  const identity = defaultIdentity({ id: "seal-agent" });
  const init = await Network.init({ layout, networkId: "acme", remote, identity });
  network = init.network;
  await network.createRoom(ROOM, { title: "Architecture" });

  // Eight messages against a window of three → five get sealed.
  await send("one");
  await send("two");
  await send("Refunds are partial-capable\n\nAgreed after discussion.", "decision");
  await send("four");
  await send("five");
  await send("six");
  await send("seven");
  await send("eight");
});

after(async () => {
  network.close();
  await rm(tmp, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("sealing", () => {
  let sealedIds: string[];

  it("decides what falls outside the window without touching anything", async () => {
    const sealer = new Sealer({
      repo: network.repo,
      layout,
      networkId: "acme",
      agentId: "seal-agent",
      remote,
    });
    const decision = await sealer.decide(ROOM, TIGHT);

    assert.equal(decision.shouldSeal, true);
    assert.equal(decision.toSeal.length, 5, "eight messages, window of three");
    assert.equal(decision.keeping, 3);
    // Oldest first — the window keeps the most recent.
    assert.equal(decision.toSeal[0]?.body.trim(), "one");
    sealedIds = decision.toSeal.map((m) => m.header.id);

    // Nothing moved.
    const store = new RoomStore(layout.roomWorktree("acme", ROOM), ROOM);
    assert.equal((await store.listMessagePaths()).length, 8);
  });

  it("seals: merges to main, writes a digest, prunes the live branch", async () => {
    const sealer = new Sealer({
      repo: network.repo,
      layout,
      networkId: "acme",
      agentId: "seal-agent",
      remote,
    });
    const result = await sealer.seal(ROOM, TIGHT);

    assert.equal(result.skipped, undefined, `unexpected skip: ${String(result.skipped)}`);
    assert.equal(result.sealed, 5);
    assert.ok(result.digest, "a digest must be written");

    // The live branch keeps only the window.
    const store = new RoomStore(layout.roomWorktree("acme", ROOM), ROOM);
    const remaining = await store.listMessagePaths();
    assert.equal(remaining.length, 3, "the live window must be exactly the retained messages");
  });

  it("keeps every sealed message readable from history — pruning is not data loss", async () => {
    // The load-bearing claim of the whole retention design. The files are gone
    // from both trees; they must still be reachable through git.
    const history = await network.history(ROOM);
    const ids = new Set(history.map((m) => m.header.id));

    for (const id of sealedIds) {
      assert.ok(ids.has(id), `sealed message ${id} is unreachable from history — data was LOST`);
    }
    assert.equal(history.length, 8, "history must still hold every message ever sent");
  });

  it("carries the raw messages into main's history via the merge", async () => {
    // The merge is what makes the deletion safe: without it the pruned commits
    // would be reachable from no ref at all.
    const { stdout } = await exec("git", [
      "-C",
      layout.gitDir("acme"),
      "log",
      "main",
      "--diff-filter=A",
      "--name-only",
      "--format=",
      "--",
      `rooms/${ROOM}/msg/`,
    ]);
    const paths = stdout.split("\n").filter((l) => l.trim().length > 0);
    assert.equal(paths.length, 8, "main's history must contain all eight messages");
  });

  it("leaves no raw messages in main's tree — main is the record, not the log", async () => {
    const onMain = await new RoomStore(layout.recordWorktree("acme"), ROOM).listMessagePaths();
    assert.deepEqual(onMain, []);
  });

  it("promotes decisions, which are never pruned", async () => {
    const record = layout.recordWorktree("acme");
    const { readdir } = await import("node:fs/promises");
    const decisions = await readdir(join(record, "rooms", ROOM, "decisions"));
    assert.equal(decisions.length, 1);
    assert.match(decisions[0] as string, /^0001-refunds-are-partial-capable\.md$/);

    const body = await readFile(
      join(record, "rooms", ROOM, "decisions", decisions[0] as string),
      "utf8",
    );
    assert.match(body, /decided_by: seal-agent/);
    assert.match(body, /source_message: [0-9A-HJKMNP-TV-Z]{26}/);
  });

  it("writes a digest that preserves what the raw messages would have told you", async () => {
    const record = layout.recordWorktree("acme");
    const { readdir } = await import("node:fs/promises");
    const digests = await readdir(join(record, "rooms", ROOM, "digest"));
    assert.equal(digests.length, 1);

    const digest = await readFile(
      join(record, "rooms", ROOM, "digest", digests[0] as string),
      "utf8",
    );
    assert.match(digest, /## Participants/);
    assert.match(digest, /seal-agent — 5/);
    assert.match(digest, /## Decisions/);
    assert.match(digest, /## Unresolved questions/);
    // The escape hatch back to the full text must be in the digest itself.
    assert.match(digest, /komnet history architecture/);
  });

  it("is idempotent — a second seal finds nothing to do", async () => {
    const sealer = new Sealer({
      repo: network.repo,
      layout,
      networkId: "acme",
      agentId: "seal-agent",
      remote,
    });
    const again = await sealer.seal(ROOM, TIGHT);
    assert.equal(again.sealed, 0);
    assert.ok(again.skipped, "a re-run must skip rather than re-seal");
  });

  it("releases the seal lock", async () => {
    const lock = join(layout.roomWorktree("acme", ROOM), "rooms", ROOM, ".seal", "lock.json");
    assert.equal(await exists(lock), false, "a held lock would wedge the room for everyone");
  });

  it("refuses to seal while another node holds the lock", async () => {
    // Simulate a peer holding the lock by pushing one straight to the remote.
    const peer = join(tmp, "peer");
    await exec("git", ["clone", "--quiet", "--branch", roomRef(ROOM), remote, peer]);
    const lockDir = join(peer, "rooms", ROOM, ".seal");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "lock.json"),
      JSON.stringify({
        v: 1,
        holder: "other-agent",
        acquired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 900_000).toISOString(),
      }),
    );
    await exec("git", ["-C", peer, "add", "-A"]);
    await exec("git", [
      "-C",
      peer,
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--quiet",
      "-m",
      "peer takes the lock",
    ]);
    await exec("git", ["-C", peer, "push", "--quiet", "origin", `HEAD:${roomRef(ROOM)}`]);

    // Push enough new messages that a seal would otherwise be due.
    await send("nine");
    await send("ten");
    await send("eleven");

    const sealer = new Sealer({
      repo: network.repo,
      layout,
      networkId: "acme",
      agentId: "seal-agent",
      remote,
    });
    const blocked = await sealer.seal(ROOM, TIGHT);
    assert.equal(blocked.sealed, 0);
    assert.match(blocked.skipped ?? "", /lock/i);
  });
});
