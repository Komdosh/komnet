import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { defaultIdentity } from "../src/config.ts";
import { Layout } from "../src/layout.ts";
import { MAX_WAIT_MS, MIN_WAIT_MS, Network, clampWaitMs } from "../src/network.ts";

const exec = promisify(execFile);

process.env["GIT_AUTHOR_NAME"] = "komnet test";
process.env["GIT_AUTHOR_EMAIL"] = "test@komnet.invalid";
process.env["GIT_COMMITTER_NAME"] = "komnet test";
process.env["GIT_COMMITTER_EMAIL"] = "test@komnet.invalid";

let tmp: string;
let alice: Network;
let bob: Network;

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "komnet-receipts-"));
  const remote = join(tmp, "transport.git");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);

  const open = async (id: string): Promise<Network> =>
    (
      await Network.init({
        layout: new Layout(join(tmp, id)),
        networkId: "acme",
        remote,
        identity: defaultIdentity({ id }),
      })
    ).network;

  // Two separate clones: routing never returns a message to its own author, so
  // a single-network fixture would assert against an empty inbox and pass
  // without testing anything.
  alice = await open("alice");
  await alice.createRoom("general");
  await alice.createRoom("side");
  bob = await open("bob");
  await bob.joinRoom("general");
  await bob.sync();
});

after(async () => {
  alice.close();
  bob.close();
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("read receipts", () => {
  let asked: string;

  it("publishes nothing until something has actually been read", async () => {
    asked = (
      await alice.send("general", {
        body: "did you get this?",
        needs: "agent",
        mentions: ["bob"],
      })
    ).header.id;
    await bob.sync();

    assert.deepEqual(
      await alice.readReceipts("general"),
      [],
      "a receipt before anything was read would assert something untrue",
    );
    assert.equal(
      await bob.publishReceipt("general"),
      false,
      "delivery is not reading — nothing has been looked at, so there is no mark",
    );
  });

  it("counts reading as reading, without waiting for the work to be finished", async () => {
    // A receipt used to be derived from DRAINED items, so "read" meant
    // "processed and done with": a peer asking "did they see it?" was told no
    // about a message the agent had read and was actively working on.
    const peeked = bob.inbox({ room: "general" });
    assert.ok(peeked.length > 0, "bob has the message");
    assert.ok(
      peeked.every((item) => item.processedAt === null),
      "peeking must not mark anything processed",
    );

    assert.equal(await bob.publishReceipt("general"), true, "reading it is enough to receipt it");
    await alice.sync();
    const receipts = await alice.readReceipts("general");
    assert.equal(receipts[0]?.agent, "bob");
    assert.equal(receipts[0]?.readThrough, asked);
  });

  it("does not move the read mark when the work is finished", async () => {
    // Draining means "processed", which is a different fact from "read". The
    // receipt was already correct the moment bob looked; finishing must not
    // restate it, and must not produce a second commit on main.
    const pending = bob.inbox({ room: "general" });
    assert.equal(pending.length, 1, "the question must have reached bob");
    bob.drainInbox(pending.map((item) => item.id));

    assert.equal(
      await bob.publishReceipt("general"),
      false,
      "already read and published; completing it says nothing new",
    );
    await alice.sync();

    const receipts = await alice.readReceipts("general");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.agent, "bob");
    assert.equal(receipts[0]?.count, 1);
    assert.equal(
      receipts[0]?.readThrough,
      asked,
      "the sender compares their own id against this to know it was read",
    );
    // ULIDs sort chronologically, which is what makes the comparison work.
    assert.ok((receipts[0]?.readThrough ?? "") >= asked);
  });

  it("does not commit again when the mark has not moved", async () => {
    assert.equal(
      await bob.publishReceipt("general"),
      false,
      "re-publishing an unchanged mark would put a commit on main every time an agent looked",
    );
  });

  it("advances as more is read", async () => {
    const second = (
      await alice.send("general", { body: "and this?", needs: "agent", mentions: ["bob"] })
    ).header.id;
    await bob.sync();
    bob.drainInbox(bob.inbox({ room: "general" }).map((item) => item.id));

    assert.equal(await bob.publishReceipt("general"), true);
    await alice.sync();
    const receipt = (await alice.readReceipts("general"))[0];
    assert.equal(receipt?.readThrough, second);
    assert.equal(receipt?.count, 2);
  });
});

describe("mention discovery", () => {
  it("finds a mention in a room the agent never joined", async () => {
    // Routing works within subscriptions, so this message reaches nothing:
    // bob does not follow `side`, and his inbox is structurally blind to it.
    const stranded = (
      await alice.send("side", { body: "bob, the schema moved", needs: "agent", mentions: ["bob"] })
    ).header.id;
    await bob.sync();

    // Asking the inbox about an unjoined room USED to answer `[]`, which reads
    // as "the room is quiet" when the truth is "this machine never listened".
    // That ambiguity is now a refusal.
    assert.throws(
      () => bob.inbox({ room: "side" }),
      /does not subscribe/,
      "an unjoined room must refuse, not report itself empty",
    );

    const found = await bob.discoverMentions();
    assert.equal(found.length, 1, "the message is addressed to bob and must be findable");
    assert.equal(found[0]?.id, stranded);
    assert.equal(found[0]?.room, "side");
    assert.equal(found[0]?.from, "alice");
  });

  it("ignores rooms the agent already follows, and its own messages", async () => {
    const found = await bob.discoverMentions();
    assert.ok(
      found.every((item) => item.room !== "general"),
      "a subscribed room is the inbox's job, not discovery's",
    );

    // Alice follows both rooms and wrote everything in them, so she has
    // nothing to discover — an agent must never discover itself.
    assert.deepEqual(await alice.discoverMentions(), []);
  });

  it("does not report an unaddressed message as a mention", async () => {
    await alice.send("side", { body: "general notice, nobody named", needs: "none" });
    const found = await bob.discoverMentions();
    assert.equal(found.length, 1, "@room addresses subscribers, and bob is not one here");
  });
});

describe("bounded wait", () => {
  it("returns immediately when something already matches", async () => {
    await alice.send("general", { body: "waiting test", needs: "agent", mentions: ["bob"] });
    await bob.sync();

    const started = Date.now();
    const result = await bob.waitForInbox({ room: "general", timeoutMs: 30_000 });
    assert.equal(result.timedOut, false);
    assert.ok(result.items.length > 0);
    assert.ok(Date.now() - started < 5_000, "a satisfied wait must not sit out its timeout");
  });

  it("reports a timeout as a distinct outcome, not an error", async () => {
    bob.drainInbox(bob.inbox({}).map((item) => item.id));

    const result = await bob.waitForInbox({ room: "general", timeoutMs: 1_500, pollMs: 500 });
    assert.equal(result.timedOut, true);
    assert.deepEqual(result.items, [], "a timeout is 'nothing yet', never a failure");
  });

  it("caps the timeout regardless of what the caller asks for", () => {
    // The ceiling is not politeness: this is reached over MCP, whose clients
    // enforce their own request timeouts, so a longer block is killed by the
    // transport rather than answered. Asserted on the arithmetic rather than by
    // sitting out a minute of CI on every run.
    assert.equal(clampWaitMs(999_000), MAX_WAIT_MS);
    assert.equal(clampWaitMs(60_001), MAX_WAIT_MS);
    assert.equal(clampWaitMs(0), MIN_WAIT_MS);
    assert.equal(clampWaitMs(undefined), 30_000);
    assert.equal(clampWaitMs(5_000), 5_000);
  });
});
