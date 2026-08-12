import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { HANDSHAKE_ACK_TAG, HANDSHAKE_TAG } from "@komnet/protocol";

import { defaultIdentity } from "../src/config.ts";
import { Layout } from "../src/layout.ts";
import { Network } from "../src/network.ts";

const exec = promisify(execFile);

process.env["GIT_AUTHOR_NAME"] = "komnet test";
process.env["GIT_AUTHOR_EMAIL"] = "test@komnet.invalid";
process.env["GIT_COMMITTER_NAME"] = "komnet test";
process.env["GIT_COMMITTER_EMAIL"] = "test@komnet.invalid";

const ROOM = "architecture";

let tmp: string;
let alice: Network;
let bob: Network;

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "komnet-handshake-"));
  const remote = join(tmp, "transport.git");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);

  const open = async (id: string): Promise<Network> => {
    const init = await Network.init({
      layout: new Layout(join(tmp, id)),
      networkId: "acme",
      remote,
      identity: defaultIdentity({ id }),
    });
    return init.network;
  };

  // Two genuinely separate agents with separate clones. A handshake sent to
  // oneself is never routed back (`shouldDeliverMessage` drops own messages), so
  // a single-network test would assert against an empty inbox and pass
  // vacuously — the failure mode this suite has shipped before.
  alice = await open("alice-claude");
  await alice.createRoom(ROOM);
  bob = await open("bob-codex");
  await bob.joinRoom(ROOM);
  await bob.sync();
});

after(async () => {
  alice.close();
  bob.close();
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("handshake", () => {
  let opened: string;

  it("announces presence, greets the room, and reports who could answer", async () => {
    const result = await alice.handshake({ room: ROOM, note: "wiring up the release room" });
    opened = result.message.header.id;

    assert.equal(result.role, "open");
    assert.equal(result.room, ROOM);
    assert.equal(result.synced, true);
    assert.equal(result.presencePublished, true, "first handshake must publish a live transition");
    assert.deepEqual(result.message.header.tags, [HANDSHAKE_TAG]);
    assert.deepEqual(result.message.header.mentions, ["@room"]);
    assert.equal(
      result.message.header.needs,
      "agent",
      "an opening must be answerable by the peer agent, not parked on a person",
    );
    assert.equal(result.thread, result.message.header.id, "an opening starts its own thread");

    // The roster is the point of the report: it is what tells the caller
    // whether a reply is plausible soon or hours away.
    assert.deepEqual(
      result.peers.map((peer) => peer.id),
      ["bob-codex"],
      "peers must list the other agents, never this one",
    );
    assert.equal(result.peers[0]?.status, "away");

    const live = await alice.listAgents();
    assert.equal(live.find((card) => card.id === "alice-claude")?.presence.status, "live");
  });

  it("delivers to the peer with the tag intact on the cached inbox row", async () => {
    await bob.sync();
    const pending = bob.inbox({});
    const item = pending.find((candidate) => candidate.id === opened);

    assert.ok(item !== undefined, "the greeting must reach a subscribed peer's inbox");
    assert.deepEqual(item.tags, [HANDSHAKE_TAG]);
    assert.deepEqual(
      bob.inbox({ tag: HANDSHAKE_TAG }).map((row) => row.id),
      [opened],
      "the tag filter is what lets a watcher classify an item without re-reading git",
    );
    assert.deepEqual(bob.inbox({ tag: "no-such-tag" }), []);
  });

  it("acks into the same thread, addressed back to the opener", async () => {
    const ack = await bob.handshake({ ackTo: opened });

    assert.equal(ack.role, "ack");
    assert.equal(ack.room, ROOM);
    assert.equal(ack.thread, opened, "an ack must join the thread it answers");
    assert.equal(ack.message.header.inReplyTo, opened);
    assert.deepEqual(ack.message.header.tags, [HANDSHAKE_ACK_TAG]);
    assert.deepEqual(ack.message.header.mentions, ["alice-claude"]);
    assert.equal(ack.message.header.needs, "none", "an ack closes the exchange");
    assert.deepEqual(
      ack.peers.map((peer) => peer.id),
      ["alice-claude"],
    );

    assert.equal(
      bob.inbox({}).some((row) => row.id === opened),
      false,
      "acking a handshake must clear it, or it is announced again on every poll",
    );
  });

  it("closes the loop: the opener sees the ack in the thread it was watching", async () => {
    await alice.sync();
    const reply = alice.inbox({ tag: HANDSHAKE_ACK_TAG })[0];

    assert.ok(reply !== undefined, "the ack must come back to the agent that opened");
    assert.equal(reply.from, "bob-codex");
    assert.equal(reply.thread, opened, "watching the thread is what finds the reply");
  });

  it("refuses to ack an ack, so two automated agents cannot loop forever", async () => {
    await alice.sync();
    const ack = alice.inbox({ tag: HANDSHAKE_ACK_TAG })[0];
    assert.ok(ack !== undefined);

    await assert.rejects(
      () => alice.handshake({ ackTo: ack.id }),
      /is not an open handshake/,
      "only an item tagged 'handshake' is answerable this way",
    );
  });

  it("refuses to ack a message that asked for a person", async () => {
    const parked = await alice.send(ROOM, {
      body: "should we cut the release today?",
      kind: "question",
      needs: "human",
      mentions: ["bob-codex"],
      tags: [HANDSHAKE_TAG],
    });
    await bob.sync();

    await assert.rejects(
      () => bob.handshake({ ackTo: parked.header.id }),
      /needs: human/,
      "an automated ack must never stand in for a person's decision (ADR 0012)",
    );
  });

  it("rejects a handshake with neither a room nor a message to answer", async () => {
    await assert.rejects(() => alice.handshake({}), /needs a room/);
  });
});
