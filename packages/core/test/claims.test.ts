import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { createClaim, createMessage, ulid, type Claim, type Message } from "@komnet/protocol";

import { defaultIdentity } from "../src/config.ts";
import { Layout } from "../src/layout.ts";
import { Network } from "../src/network.ts";
import { currentHolder, reduceClaims } from "../src/room/claims.ts";

const exec = promisify(execFile);

process.env["GIT_AUTHOR_NAME"] = "komnet test";
process.env["GIT_AUTHOR_EMAIL"] = "test@komnet.invalid";
process.env["GIT_COMMITTER_NAME"] = "komnet test";
process.env["GIT_COMMITTER_EMAIL"] = "test@komnet.invalid";

const RESOURCE = "core/social/graph";

function claimEvent(from: string, claim: Claim, ts: string, body = "working"): Message {
  const id = ulid();
  return createMessage({
    id,
    room: "builds",
    from,
    authorKind: "agent",
    kind: "status",
    needs: "none",
    thread: id,
    ts,
    body,
    claim,
  });
}

describe("claim reduction", () => {
  const at = (minutes: number): string =>
    new Date(Date.parse("2026-08-13T10:00:00.000Z") + minutes * 60_000).toISOString();
  const now = Date.parse("2026-08-13T10:05:00.000Z");

  it("gives the resource to the first claim and makes the loser visible", () => {
    const alice = claimEvent(
      "alice-codex",
      createClaim({ id: ulid(), resource: RESOURCE, holder: "alice-codex", ttlSeconds: 600 }),
      at(0),
    );
    const bob = claimEvent(
      "bob-claude",
      createClaim({ id: ulid(), resource: RESOURCE, holder: "bob-claude", ttlSeconds: 600 }),
      at(1),
    );

    const [status] = reduceClaims([bob, alice], now);
    assert.equal(status?.holder, "alice-codex", "the earlier event wins, on every machine");
    assert.deepEqual(status?.contenders, ["bob-claude"], "the loser must be able to find out");
    assert.equal(status?.expired, false);
  });

  it("frees the resource when the hold expires, so a crashed holder cannot strand it", () => {
    // The failure the chat-message convention had no answer for: the holder
    // dies before saying "BUILD-DONE" and nobody can ever build again.
    const held = claimEvent(
      "alice-codex",
      createClaim({ id: ulid(), resource: RESOURCE, holder: "alice-codex", ttlSeconds: 60 }),
      at(0),
    );
    const [status] = reduceClaims([held], now);
    assert.equal(status?.expired, true);
    assert.equal(currentHolder(reduceClaims([held], now), RESOURCE), null);

    // And a later claimant simply takes it.
    const bob = claimEvent(
      "bob-claude",
      createClaim({ id: ulid(), resource: RESOURCE, holder: "bob-claude", ttlSeconds: 600 }),
      at(4),
    );
    assert.equal(currentHolder(reduceClaims([held, bob], now), RESOURCE)?.holder, "bob-claude");
  });

  it("lets the holder renew, and only the holder release", () => {
    const first = claimEvent(
      "alice-codex",
      createClaim({ id: ulid(), resource: RESOURCE, holder: "alice-codex", ttlSeconds: 120 }),
      at(0),
    );
    const renewal = claimEvent(
      "alice-codex",
      createClaim({ id: ulid(), resource: RESOURCE, holder: "alice-codex", ttlSeconds: 600 }),
      at(1),
    );
    assert.equal(
      currentHolder(reduceClaims([first, renewal], now), RESOURCE)?.holder,
      "alice-codex",
      "a renewal extends rather than contending with itself",
    );

    // A release from someone who does not hold it must not free it.
    const strayRelease = claimEvent(
      "bob-claude",
      createClaim({
        id: ulid(),
        resource: RESOURCE,
        holder: "bob-claude",
        action: "released",
        ttlSeconds: 600,
      }),
      at(2),
    );
    assert.equal(
      currentHolder(reduceClaims([first, renewal, strayRelease], now), RESOURCE)?.holder,
      "alice-codex",
    );

    const ownRelease = claimEvent(
      "alice-codex",
      createClaim({
        id: ulid(),
        resource: RESOURCE,
        holder: "alice-codex",
        action: "released",
        ttlSeconds: 600,
      }),
      at(3),
    );
    assert.equal(currentHolder(reduceClaims([first, renewal, ownRelease], now), RESOURCE), null);
  });
});

describe("claiming across two machines", () => {
  let tmp: string;
  let alice: Network;
  let bob: Network;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "komnet-claims-"));
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
    await alice.createRoom("builds");
    bob = (
      await Network.init({
        layout: new Layout(join(tmp, "bob")),
        networkId: "acme",
        remote,
        identity: defaultIdentity({ id: "bob-claude" }),
      })
    ).network;
    await bob.joinRoom("builds");
  });

  after(async () => {
    alice.close();
    bob.close();
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("grants one holder and refuses the other, with the same answer on both machines", async () => {
    const first = await alice.claimResource("builds", RESOURCE, {
      ttlSeconds: 600,
      note: "assembling :graph:boot",
    });
    assert.equal(first.granted, true);
    assert.equal(first.status?.holder, "alice-codex");

    // Bob asks for the same resource. He must be told no — and told by whom.
    const second = await bob.claimResource("builds", RESOURCE, { ttlSeconds: 600 });
    assert.equal(second.granted, false, "two agents must not both believe they hold it");
    assert.equal(second.status?.holder, "alice-codex");
    assert.match(second.status?.note ?? "", /assembling/);

    // Both machines agree, which is what makes this usable as a lock.
    await alice.sync();
    assert.equal(currentHolder(await alice.listClaims("builds"), RESOURCE)?.holder, "alice-codex");
    assert.equal(currentHolder(await bob.listClaims("builds"), RESOURCE)?.holder, "alice-codex");
  });

  it("hands the resource over once the holder releases", async () => {
    assert.equal(await alice.releaseResource("builds", RESOURCE), true);
    await bob.sync();
    assert.equal(currentHolder(await bob.listClaims("builds"), RESOURCE), null);

    const second = await bob.claimResource("builds", RESOURCE, { ttlSeconds: 600 });
    assert.equal(second.granted, true, "a released resource is free for the next agent");
    assert.equal(second.status?.holder, "bob-claude");
  });

  it("refuses to release something this agent does not hold", async () => {
    assert.equal(
      await alice.releaseResource("builds", RESOURCE),
      false,
      "releasing a peer's hold would be the bug the holder check exists to prevent",
    );
    await bob.sync();
    assert.equal(currentHolder(await bob.listClaims("builds"), RESOURCE)?.holder, "bob-claude");
  });

  it("rejects a resource name two agents could spell differently", async () => {
    await assert.rejects(alice.claimResource("builds", "Core Social Graph"), /not a usable/);
    await assert.rejects(alice.claimResource("builds", "../escape"), /not a usable/);
  });
});
