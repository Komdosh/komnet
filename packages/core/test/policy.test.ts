import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, beforeEach, describe, it } from "node:test";

import { defaultIdentity } from "../src/config.ts";
import { ApprovalRequiredError } from "../src/errors.ts";
import { Layout } from "../src/layout.ts";
import { Network } from "../src/network.ts";
import {
  DEFAULT_LOCAL_POLICY,
  approvalRequired,
  originOf,
  parseLocalPolicy,
  policySearchPath,
  policyTemplate,
} from "../src/policy.ts";

const exec = promisify(execFile);

process.env["GIT_AUTHOR_NAME"] = "komnet test";
process.env["GIT_AUTHOR_EMAIL"] = "test@komnet.invalid";
process.env["GIT_COMMITTER_NAME"] = "komnet test";
process.env["GIT_COMMITTER_EMAIL"] = "test@komnet.invalid";

describe("policy file", () => {
  it("defaults to asking about remote work and nothing else", () => {
    assert.equal(DEFAULT_LOCAL_POLICY.approvals.inboundWork, "remote");
    assert.deepEqual(DEFAULT_LOCAL_POLICY.approvals.localAgents, []);
  });

  it("parses the template it ships, so the documented example is the real grammar", () => {
    const parsed = parseLocalPolicy(policyTemplate(), "template");
    assert.equal(parsed.approvals?.inboundWork, "remote");
    assert.deepEqual(parsed.approvals?.localAgents, []);
  });

  it("refuses a misspelled key instead of silently ignoring it", () => {
    // The whole point of this file is constraining an agent. Ignoring an
    // unknown key would leave a person believing a limit is in force.
    assert.throws(
      () => parseLocalPolicy("v: 1\napprovals:\n  inboundwork: never\n", "p.yaml"),
      /unknown key 'approvals.inboundwork'/,
    );
    assert.throws(() => parseLocalPolicy("approval:\n  x: 1\n", "p.yaml"), /unknown top-level key/);
  });

  it("refuses an unknown mode, a bad agent id, and a future version", () => {
    assert.throws(
      () => parseLocalPolicy("approvals:\n  inboundWork: sometimes\n", "p.yaml"),
      /must be one of: never, remote, always/,
    );
    assert.throws(
      () => parseLocalPolicy("approvals:\n  localAgents: ['not a valid id']\n", "p.yaml"),
      /invalid agent id/,
    );
    assert.throws(() => parseLocalPolicy("v: 2\n", "p.yaml"), /unsupported policy version 2/);
  });

  it("treats an empty file as all defaults", () => {
    assert.deepEqual(parseLocalPolicy("", "p.yaml"), {});
    assert.deepEqual(parseLocalPolicy("# just a comment\n", "p.yaml"), {});
  });

  it("looks in the machine root as well, when running as a provisioned agent", () => {
    const machine = policySearchPath(new Layout("/home/u/.komnet"));
    assert.deepEqual(machine, ["/home/u/.komnet/policy.yaml"]);

    // A per-agent home is <root>/agents/<id>. Without the machine-root lookup a
    // policy set once would be silently ignored by every provisioned agent.
    const agent = policySearchPath(new Layout("/home/u/.komnet/agents/bob-codex"));
    assert.deepEqual(agent, [
      "/home/u/.komnet/policy.yaml",
      "/home/u/.komnet/agents/bob-codex/policy.yaml",
    ]);
  });
});

describe("work origin", () => {
  const policy = { inboundWork: "remote" as const, localAgents: ["sibling-codex"] };

  it("counts this agent and listed agents as local, everything else as remote", () => {
    assert.equal(originOf("me-claude", "me-claude", policy), "local");
    assert.equal(originOf("sibling-codex", "me-claude", policy), "local");
    assert.equal(originOf("stranger-cursor", "me-claude", policy), "remote");
  });

  it("applies each mode to each origin", () => {
    const modes = ["never", "remote", "always"] as const;
    const expected: Record<string, [boolean, boolean]> = {
      // [local, remote]
      never: [false, false],
      remote: [false, true],
      always: [true, true],
    };
    for (const mode of modes) {
      const p = { inboundWork: mode, localAgents: [] };
      const [local, remote] = expected[mode] as [boolean, boolean];
      assert.equal(approvalRequired("local", p), local, `${mode}/local`);
      assert.equal(approvalRequired("remote", p), remote, `${mode}/remote`);
    }
  });
});

describe("inbound work gate", () => {
  let tmp: string;
  let remote: string;
  let alice: Network;
  let bob: Network;
  let bobHome: string;

  async function setBobPolicy(body: string | null): Promise<void> {
    const path = join(bobHome, "policy.yaml");
    if (body === null) await rm(path, { force: true });
    else await writeFile(path, body, "utf8");
  }

  /** A fresh task from alice, synced into bob's view. Returns its id. */
  async function delegate(title: string): Promise<string> {
    const created = await alice.createTask("gate", { title, definition: `${title} definition.` });
    await bob.sync();
    return created.header.task?.id as string;
  }

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "komnet-policy-"));
    remote = join(tmp, "transport.git");
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
    alice = (
      await Network.init({
        layout: new Layout(join(tmp, "alice")),
        networkId: "acme",
        remote,
        identity: defaultIdentity({ id: "alice-codex" }),
      })
    ).network;
    await alice.createRoom("gate");
    bobHome = join(tmp, "bob");
    bob = (
      await Network.init({
        layout: new Layout(bobHome),
        networkId: "acme",
        remote,
        identity: defaultIdentity({ id: "bob-claude" }),
      })
    ).network;
    await bob.joinRoom("gate");
  });

  beforeEach(async () => {
    await setBobPolicy(null);
  });

  after(async () => {
    alice.close();
    bob.close();
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("refuses a remote teammate's task by default, and says exactly how to proceed", async () => {
    const taskId = await delegate("Wire the ledger migration");
    const error = await bob
      .claimTask("gate", taskId, "Taking it.")
      .then(() => null)
      .catch((e: unknown) => e);

    assert.ok(error instanceof ApprovalRequiredError, `expected a refusal, got ${String(error)}`);
    assert.equal(error.code, "APPROVAL_REQUIRED");
    assert.equal(error.requester, "alice-codex");
    assert.equal(error.kind, "task");
    assert.match(error.message, /komnet task approve gate/);

    // The refusal must not have half-happened: nobody owns the task.
    const status = (await bob.listTasks("gate")).find((t) => t.task.id === taskId);
    assert.equal(status?.task.state, "open");
    assert.equal(status?.task.assignee, undefined);
  });

  it("lets the claim through once a person has approved it, and only that one", async () => {
    const approved = await delegate("Approved work");
    const other = await delegate("Not approved work");

    await bob.approveInboundWork("task", "gate", approved, "andrey said go");
    const claimed = await bob.claimTask("gate", approved, "Taking it.");
    assert.equal(claimed.header.task?.assignee, "bob-claude");

    await assert.rejects(
      bob.claimTask("gate", other, "Taking this one too."),
      (error: unknown) => error instanceof ApprovalRequiredError,
      "approval is per piece of work, never a blanket unlock",
    );

    const records = await bob.listApprovals();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.id, approved);
    assert.equal(records[0]?.note, "andrey said go");
  });

  it("never gates work this agent created for itself", async () => {
    const own = await bob.createTask("gate", {
      title: "My own work",
      definition: "Nobody delegated this.",
    });
    const claimed = await bob.claimTask("gate", own.header.task?.id as string, "Mine.");
    assert.equal(claimed.header.task?.assignee, "bob-claude");
  });

  it("treats a listed agent as local", async () => {
    const taskId = await delegate("From a listed peer");
    await setBobPolicy("v: 1\napprovals:\n  localAgents: [alice-codex]\n");
    const claimed = await bob.claimTask("gate", taskId, "Taking it.");
    assert.equal(claimed.header.task?.assignee, "bob-claude");
  });

  it("takes anything when set to never, and everything when set to always", async () => {
    const remoteTask = await delegate("Remote under never");
    await setBobPolicy("v: 1\napprovals:\n  inboundWork: never\n");
    assert.equal(
      (await bob.claimTask("gate", remoteTask, "Taking it.")).header.task?.assignee,
      "bob-claude",
    );

    await setBobPolicy("v: 1\napprovals:\n  inboundWork: always\n");
    const own = await bob.createTask("gate", {
      title: "Own work under always",
      definition: "Even this is gated.",
    });
    await assert.rejects(
      bob.claimTask("gate", own.header.task?.id as string, "Mine."),
      (error: unknown) => error instanceof ApprovalRequiredError,
      "'always' must gate even work the agent created itself",
    );
  });

  it("re-reads the file, so tightening the rules takes effect immediately", async () => {
    await setBobPolicy("v: 1\napprovals:\n  inboundWork: never\n");
    const first = await delegate("Before tightening");
    await bob.claimTask("gate", first, "Taking it.");

    await setBobPolicy("v: 1\napprovals:\n  inboundWork: remote\n");
    const second = await delegate("After tightening");
    await assert.rejects(
      bob.claimTask("gate", second, "Taking it."),
      (error: unknown) => error instanceof ApprovalRequiredError,
      "a policy change must not wait for a restart",
    );
  });

  it("withdraws an approval that has not been used", async () => {
    const taskId = await delegate("Withdrawn");
    await bob.approveInboundWork("task", "gate", taskId);
    assert.equal(await bob.revokeApproval("task", taskId), true);
    assert.equal(await bob.revokeApproval("task", taskId), false);
    await assert.rejects(
      bob.claimTask("gate", taskId, "Taking it."),
      (error: unknown) => error instanceof ApprovalRequiredError,
    );
  });

  it("holds the gate when the approvals file is corrupt, rather than opening it", async () => {
    const taskId = await delegate("Corrupt store");
    await bob.approveInboundWork("task", "gate", taskId);
    await writeFile(join(bobHome, "networks", "acme", "approvals.json"), "{ truncated", "utf8");
    await assert.rejects(
      bob.claimTask("gate", taskId, "Taking it."),
      (error: unknown) => error instanceof ApprovalRequiredError,
      "an unreadable approvals file must fail closed",
    );
  });

  it("gates a delegated repository review the same way, and releases it on approval", async () => {
    // A review request is the same shape of inbound work as a task: a remote
    // teammate asking this agent to go and do something.
    const requested = await alice.requestReview("gate", {
      reviewer: "bob-claude",
      repo: "github.com/acme/payments",
      baseRev: "1".repeat(40),
      headRev: "2".repeat(40),
      summary: "Review the refund idempotency change.",
    });
    const reviewId = requested.header.review?.id as string;
    await bob.sync();

    const error = await bob
      .updateReview("gate", reviewId, { state: "claimed", body: "Starting the review." })
      .then(() => null)
      .catch((e: unknown) => e);
    assert.ok(error instanceof ApprovalRequiredError, `expected a refusal, got ${String(error)}`);
    assert.equal(error.kind, "review");
    assert.equal(error.requester, "alice-codex");
    assert.match(error.message, /komnet review approve gate/);

    await bob.approveInboundWork("review", "gate", reviewId);
    const claimed = await bob.updateReview("gate", reviewId, {
      state: "claimed",
      body: "Starting the review.",
    });
    assert.equal(claimed.header.review?.state, "claimed");
  });

  it("does not gate reporting findings once the review is under way", async () => {
    // Only taking work on is gated. An agent already doing the work must not
    // need a second approval to say what it found.
    const requested = await alice.requestReview("gate", {
      reviewer: "bob-claude",
      repo: "github.com/acme/payments",
      baseRev: "3".repeat(40),
      headRev: "4".repeat(40),
      summary: "Second review.",
    });
    const reviewId = requested.header.review?.id as string;
    await bob.sync();

    const reported = await bob.updateReview("gate", reviewId, {
      state: "reported",
      body: "No blocking findings.",
    });
    assert.equal(reported.header.review?.state, "reported");
  });

  it("reads a policy set once for the machine from a provisioned agent home", async () => {
    // <root>/agents/<id> is what `komnet agent add` creates.
    const root = join(tmp, "machine");
    const home = join(root, "agents", "carol-codex");
    await mkdir(home, { recursive: true });
    await writeFile(join(root, "policy.yaml"), "v: 1\napprovals:\n  inboundWork: always\n");

    const carol = (
      await Network.init({
        layout: new Layout(home),
        networkId: "acme",
        remote,
        identity: defaultIdentity({ id: "carol-codex" }),
      })
    ).network;
    try {
      const { policy, sources } = await carol.policy();
      assert.equal(policy.approvals.inboundWork, "always");
      assert.deepEqual(sources, [join(root, "policy.yaml")]);
    } finally {
      carol.close();
    }
  });
});
