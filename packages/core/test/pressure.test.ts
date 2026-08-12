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

const exec = promisify(execFile);

process.env["GIT_AUTHOR_NAME"] = "komnet test";
process.env["GIT_AUTHOR_EMAIL"] = "test@komnet.invalid";
process.env["GIT_COMMITTER_NAME"] = "komnet test";
process.env["GIT_COMMITTER_EMAIL"] = "test@komnet.invalid";

/** Small on purpose: the mechanism is what matters, not the number. */
const BUDGET = 4;

describe("thread pressure integration", () => {
  let tmp: string;
  let remote: string;
  let network: Network;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "komnet-pressure-"));
    remote = join(tmp, "transport.git");
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
    const init = await Network.init({
      layout: new Layout(join(tmp, "home")),
      networkId: "acme",
      remote,
      identity: defaultIdentity({ id: "alice-codex" }),
    });
    network = init.network;
    // Budget set explicitly, not inherited from DEFAULT_ROOM_POLICY. This test
    // is about the mechanism — the last allowed reply parks, a human relay
    // resets it — and coupling it to whatever the default happens to be made it
    // fail when the default was relaxed, which is not a change in behaviour.
    await network.createRoom("shared-branch", { replyBudget: BUDGET });
  });

  after(async () => {
    network.close();
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("preserves card capabilities across presence-only transitions", async () => {
    await network.publishAgentCard({ expertise: ["typescript"], speaksFor: ["komnet/core"] });
    await network.publishAgentCard({ presence: "live" });
    const card = (await network.listAgents()).find((candidate) => candidate.id === "alice-codex");
    assert.deepEqual(card?.expertise, ["typescript"]);
    assert.deepEqual(card?.speaksFor, ["komnet/core"]);
    assert.equal(card?.presence.status, "live");
  });

  it("drains a presence commit left local by an outage", async () => {
    await rename(remote, `${remote}.away`);
    try {
      await assert.rejects(() => network.publishAgentCard({ presence: "away" }));
    } finally {
      await rename(`${remote}.away`, remote);
    }

    await network.sync();
    const { stdout } = await exec(
      "git",
      ["--git-dir", remote, "show", "main:agents/alice-codex.yaml"],
      { encoding: "utf8" },
    );
    assert.match(stdout, /presence:\n\s+status: away/);
  });

  it("turns the configured final agent reply into a human handoff and resets after a relay", async () => {
    let last = await network.send("shared-branch", { body: "root" });
    for (let index = 1; index < BUDGET; index += 1) {
      last = await network.send("shared-branch", {
        body: `agent reply ${String(index)}`,
        inReplyTo: last.header.id,
      });
    }

    assert.equal(last.header.needs, "human");
    assert.ok(last.header.tags.includes("reply-budget"));

    const human = await network.send("shared-branch", {
      body: "declared human direction",
      inReplyTo: last.header.id,
      authorKind: "human",
    });
    const resumed = await network.send("shared-branch", {
      body: "resuming after direction",
      inReplyTo: human.header.id,
    });
    assert.equal(resumed.header.needs, "none");
    assert.ok(!resumed.header.tags.includes("reply-budget"));
  });

  it("does not park an ordinary agent exchange", async () => {
    // The point of relaxing the default: a real two-agent thread — question,
    // answer, clarification, answer, refinement, answer — is six messages, and
    // used to park exactly there. A marker that fires on ordinary work stops
    // meaning anything, and every parked thread costs a person's time.
    await network.createRoom("ordinary");
    let last = await network.send("ordinary", { body: "question" });
    for (let index = 1; index < 6; index += 1) {
      last = await network.send("ordinary", {
        body: `exchange ${String(index)}`,
        inReplyTo: last.header.id,
      });
      assert.equal(
        last.header.needs,
        "none",
        `message ${String(index)} of an ordinary exchange must not park for a person`,
      );
    }
    assert.ok(!last.header.tags.includes("reply-budget"));
  });
});
