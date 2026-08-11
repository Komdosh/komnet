import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { defaultIdentity } from "../src/config.ts";
import { Layout } from "../src/layout.ts";
import { Network } from "../src/network.ts";
import { RoomStore } from "../src/room/store.ts";

const exec = promisify(execFile);

process.env["GIT_AUTHOR_NAME"] = "kom-net test";
process.env["GIT_AUTHOR_EMAIL"] = "test@kom-net.invalid";
process.env["GIT_COMMITTER_NAME"] = "kom-net test";
process.env["GIT_COMMITTER_EMAIL"] = "test@kom-net.invalid";

const ROOM = "architecture";

let tmp: string;
let remote: string;
let network: Network;
let layout: Layout;

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "komnet-outbox-"));
  remote = join(tmp, "transport.git");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);

  layout = new Layout(join(tmp, "home"));
  const init = await Network.init({
    layout,
    networkId: "acme",
    remote,
    identity: defaultIdentity({ id: "outbox-agent" }),
  });
  network = init.network;
  await network.createRoom(ROOM);
});

after(async () => {
  network.close();
  await rm(tmp, { recursive: true, force: true });
});

/** Make the remote unreachable by moving it aside, then restore it. */
async function offline<T>(fn: () => Promise<T>): Promise<T> {
  await rename(remote, `${remote}.away`);
  try {
    return await fn();
  } finally {
    await rename(`${remote}.away`, remote);
  }
}

describe("durable outbox", () => {
  it("accepts a send while the remote is unreachable instead of failing", async () => {
    const message = await offline(async () =>
      network.send(ROOM, {
        body: "written while offline",
        needs: "none",
        // One attempt so the test does not sit through the backoff ladder.
      }),
    );
    assert.match(message.header.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);

    // Durable straight away: it is a git commit, not a buffer in memory.
    const onDisk = await new RoomStore(layout.roomWorktree("acme", ROOM), ROOM).listMessagePaths();
    assert.equal(
      onDisk.length,
      1,
      "the message must be committed locally even when the push fails",
    );
  });

  it("reports it as queued rather than pretending it was delivered", async () => {
    const queued = await network.outbox();
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.roomId, ROOM);
    assert.equal(queued[0]?.ahead, 1);

    const status = await network.status();
    assert.equal(status.queued, 1, "status must not claim a queued message was sent");
  });

  it("survives a restart — the queue is git, not process memory", async () => {
    network.close();
    network = Network.open(layout, network.config, defaultIdentity({ id: "outbox-agent" }));
    const queued = await network.outbox();
    assert.equal(queued[0]?.ahead, 1, "a reopened network must still see the backlog");
  });

  it("keeps queuing while offline, preserving order", async () => {
    await offline(async () => {
      await network.send(ROOM, { body: "second while offline", needs: "none" });
      await network.send(ROOM, { body: "third while offline", needs: "none" });
    });
    const queued = await network.outbox();
    assert.equal(queued[0]?.ahead, 3);
  });

  it("drains the backlog on the next sync, in order", async () => {
    const report = await network.sync();
    assert.equal(report.drained.length, 1);
    assert.equal(report.drained[0]?.pushed, 3);
    assert.deepEqual(await network.outbox(), [], "nothing should remain queued");

    // The remote really has them, in the order they were written.
    const verify = join(tmp, "verify");
    await exec("git", ["clone", "--quiet", "--branch", `room/${ROOM}`, remote, verify]);
    const bodies = await new RoomStore(verify, ROOM).readAll(() => undefined);
    assert.deepEqual(
      bodies.map((m) => m.body.trim()),
      ["written while offline", "second while offline", "third while offline"],
    );
  });

  it("does not duplicate on a second drain", async () => {
    const again = await network.sync();
    assert.deepEqual(again.drained, []);

    const verify = join(tmp, "verify2");
    await exec("git", ["clone", "--quiet", "--branch", `room/${ROOM}`, remote, verify]);
    assert.equal((await new RoomStore(verify, ROOM).listMessagePaths()).length, 3);
  });

  it("still surfaces a send that fails for a non-network reason", async () => {
    // Queuing must not swallow real errors — a blocked secret is not "offline".
    await assert.rejects(
      () => network.send(ROOM, { body: "key AKIAIOSFODNN7EXAMPLE", needs: "none" }),
      /secret/i,
    );
  });
});
