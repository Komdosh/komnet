import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { createMessage, ulid } from "@komnet/protocol";

import { verifyGitAuthor, verifyMessage } from "../src/authenticity.ts";
import { parseNetManifest, serializeNetManifest } from "../src/net.ts";
import { cardFromIdentity, parseAgentCard, serializeAgentCard } from "../src/agent/card.ts";
import { defaultIdentity } from "../src/config.ts";
import { Layout } from "../src/layout.ts";
import { Network } from "../src/network.ts";

const exec = promisify(execFile);

process.env["GIT_AUTHOR_NAME"] = "komnet test";
process.env["GIT_AUTHOR_EMAIL"] = "alice@example.invalid";
process.env["GIT_COMMITTER_NAME"] = "komnet test";
process.env["GIT_COMMITTER_EMAIL"] = "alice@example.invalid";

let tmp: string;

const message = (from: string) =>
  createMessage({
    id: ulid(),
    room: "architecture",
    from,
    authorKind: "agent",
    kind: "msg",
    needs: "none",
    body: "hello",
  });

const cardFor = (id: string, email: string) =>
  cardFromIdentity(defaultIdentity({ id }), { gitAuthor: { name: id, email } });

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "komnet-auth-"));
});

after(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("network manifest", () => {
  it("round-trips", () => {
    const manifest = {
      v: 1,
      id: "acme",
      name: "ACME",
      protocolVersion: 1,
      authenticity: "git" as const,
    };
    assert.deepEqual(parseNetManifest(serializeNetManifest(manifest)), manifest);
  });

  it("treats an unknown mode as the STRICTEST one, never as 'none'", () => {
    // Downgrading a security setting because a newer peer wrote a value we do
    // not recognise is the wrong failure direction.
    const parsed = parseNetManifest("v: 1\nid: acme\nauthenticity: quantum-something\n");
    assert.equal(parsed.authenticity, "signed");
  });

  it("defaults to git when unspecified", () => {
    assert.equal(parseNetManifest("v: 1\nid: acme\n").authenticity, "git");
  });
});

describe("agent card git binding", () => {
  it("round-trips the git author", () => {
    const card = cardFor("alice-cursor", "alice@example.invalid");
    const parsed = parseAgentCard(serializeAgentCard(card));
    assert.deepEqual(parsed.gitAuthor, { name: "alice-cursor", email: "alice@example.invalid" });
  });
});

describe("git-mode verification", () => {
  it("accepts a message whose commit author matches its card", () => {
    const result = verifyGitAuthor({
      message: message("alice-cursor"),
      commitAuthorEmail: "alice@example.invalid",
      card: cardFor("alice-cursor", "alice@example.invalid"),
      allowedSignersPath: null,
    });
    assert.equal(result.verified, true);
  });

  it("REJECTS one member writing a message as another", () => {
    // The realistic forgery inside a network where everyone can already push.
    const result = verifyGitAuthor({
      message: message("alice-cursor"),
      commitAuthorEmail: "mallory@example.invalid",
      card: cardFor("alice-cursor", "alice@example.invalid"),
      allowedSignersPath: null,
    });
    assert.equal(result.verified, false);
    assert.match(result.reason ?? "", /claims to be from 'alice-cursor'/);
  });

  it("is case-insensitive about the email", () => {
    const result = verifyGitAuthor({
      message: message("alice-cursor"),
      commitAuthorEmail: "Alice@Example.Invalid",
      card: cardFor("alice-cursor", "alice@example.invalid"),
      allowedSignersPath: null,
    });
    assert.equal(result.verified, true);
  });

  it("says precisely why when there is nothing to check against", () => {
    // A card with no binding is not a forgery signal on its own; conflating the
    // two would cry wolf on every pre-binding card.
    const noBinding = verifyGitAuthor({
      message: message("alice-cursor"),
      commitAuthorEmail: "alice@example.invalid",
      card: cardFromIdentity(defaultIdentity({ id: "alice-cursor" })),
      allowedSignersPath: null,
    });
    assert.equal(noBinding.verified, false);
    assert.match(noBinding.reason ?? "", /declares no git author/);

    const unknownAgent = verifyGitAuthor({
      message: message("ghost-agent"),
      commitAuthorEmail: "ghost@example.invalid",
      card: undefined,
      allowedSignersPath: null,
    });
    assert.match(unknownAgent.reason ?? "", /no published agent card/);
  });
});

describe("mode dispatch", () => {
  it("accepts anything under 'none'", async () => {
    const result = await verifyMessage("none", {
      message: message("anyone-at-all"),
      commitAuthorEmail: "mallory@example.invalid",
      card: undefined,
      allowedSignersPath: null,
    });
    assert.equal(result.verified, true);
  });

  it("requires a signature under 'signed'", async () => {
    const result = await verifyMessage("signed", {
      message: message("alice-cursor"),
      commitAuthorEmail: "alice@example.invalid",
      card: cardFor("alice-cursor", "alice@example.invalid"),
      allowedSignersPath: null,
    });
    assert.equal(result.verified, false);
    assert.match(result.reason ?? "", /no signature/);
  });
});

describe("end to end on a real network", () => {
  it("publishes a git binding and reports a forged message as unverified", async () => {
    const remote = join(tmp, "transport.git");
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);

    const layout = new Layout(join(tmp, "alice"));
    const { network } = await Network.init({
      layout,
      networkId: "acme",
      remote,
      identity: defaultIdentity({ id: "alice-cursor" }),
    });

    try {
      assert.equal(await network.authenticityMode(), "git", "init writes authenticity: git");

      // The card must carry the binding, or git mode can never verify anything.
      const cards = await network.listAgents();
      assert.equal(cards[0]?.gitAuthor?.email, "alice@example.invalid");

      await network.createRoom("architecture");

      // Forge: a peer commits a message claiming to be from someone else.
      const peer = join(tmp, "peer");
      await exec("git", ["clone", "--quiet", "--branch", "room/architecture", remote, peer]);
      const forged = message("alice-cursor");
      const { mkdir } = await import("node:fs/promises");
      const dir = join(peer, "rooms/architecture/msg/2026/08/11");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `20260811T120000Z-alice-cursor-${forged.header.id.slice(-10)}.md`),
        `---\nv: 1\nid: ${forged.header.id}\nroom: architecture\nfrom: alice-cursor\nauthor_kind: agent\nts: 2026-08-11T12:00:00.000Z\nkind: msg\nthread: ${forged.header.id}\nneeds: none\n---\n\nforged\n`,
        "utf8",
      );
      await exec("git", ["-C", peer, "add", "-A"]);
      await exec(
        "git",
        ["-C", peer, "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "forged"],
        {
          env: {
            ...process.env,
            GIT_AUTHOR_EMAIL: "mallory@example.invalid",
            GIT_COMMITTER_EMAIL: "mallory@example.invalid",
          },
        },
      );
      await exec("git", ["-C", peer, "push", "--quiet", "origin", "HEAD:room/architecture"]);

      const report = await network.sync();
      assert.equal(report.unverified.length, 1, "the forgery must be reported");
      assert.equal(report.unverified[0]?.from, "alice-cursor");
      assert.match(report.unverified[0]?.reason ?? "", /mallory@example\.invalid/);

      // Reported, NOT dropped — silently discarding would let an attacker
      // suppress messages by making them look unverifiable (spec §10).
      const messages = await network.read("architecture");
      assert.ok(
        messages.some((m) => m.header.id === forged.header.id),
        "an unverified message must still be recorded and readable",
      );
    } finally {
      network.close();
    }
  });
});
