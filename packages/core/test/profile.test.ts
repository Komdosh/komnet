import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { agentProfilePath } from "@komnet/protocol";

import {
  Layout,
  Network,
  SecretDetectedError,
  defaultIdentity,
  parseAgentProfile,
  profileFromIdentity,
  serializeAgentProfile,
} from "../src/index.ts";

const exec = promisify(execFile);

process.env["GIT_AUTHOR_NAME"] = "komnet test";
process.env["GIT_AUTHOR_EMAIL"] = "test@komnet.invalid";
process.env["GIT_COMMITTER_NAME"] = "komnet test";
process.env["GIT_COMMITTER_EMAIL"] = "test@komnet.invalid";

describe("agent profile", () => {
  let tmp: string;
  let remote: string;
  let network: Network;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "komnet-profile-"));
    remote = join(tmp, "transport.git");
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
    ({ network } = await Network.init({
      layout: new Layout(join(tmp, "home")),
      networkId: "acme",
      remote,
      identity: defaultIdentity({
        id: "alice-codex",
        displayName: "Alice's Codex",
        human: { name: "alice", timezone: "UTC" },
        tool: "codex",
      }),
    }));
  });

  after(async () => {
    network.close();
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("round-trips structured frontmatter and readable Markdown", () => {
    const profile = profileFromIdentity(
      defaultIdentity({ id: "alice-codex", human: { name: "alice", timezone: "UTC" } }),
      null,
      {
        role: "Payments reliability engineer",
        mission: "Help the team ship safe refunds.",
        currentFocus: "Tracing refund idempotency.",
        workspace: "github.com/acme/payments",
        capabilities: ["Read and change the payments repository"],
        responsibilities: ["Own refund correctness findings"],
        constraints: ["Cannot approve production deployment"],
        canHelpWith: ["Kotlin and distributed transaction reviews"],
      },
      { client: "mcp", platform: "darwin", architecture: "arm64" },
      new Date("2026-08-12T12:00:00.000Z"),
    );
    const raw = serializeAgentProfile(profile);
    assert.match(raw, /^---\nv: 1/m);
    assert.match(raw, /> Payments reliability engineer/);
    assert.match(raw, /## Can help with/);
    assert.deepEqual(parseAgentProfile(raw), profile);
  });

  it("publishes its own profile, exposes the short role, and skips no-op writes", async () => {
    const first = await network.publishAgentProfile(
      {
        role: "Architecture implementation agent",
        mission: "Help Alice deliver the current engineering goal.",
        currentFocus: "Implementing agent profiles.",
        workspace: "github.com/acme/komnet",
        capabilities: ["Inspect and edit TypeScript repositories"],
        responsibilities: ["Keep the profile contract correct"],
        constraints: ["Cannot grant itself repository authority"],
        canHelpWith: ["Protocol and integration design"],
      },
      { client: "mcp", platform: "darwin", architecture: "arm64" },
    );
    assert.equal(first, true);
    assert.equal(
      await network.publishAgentProfile(
        {},
        { client: "mcp", platform: "darwin", architecture: "arm64" },
      ),
      false,
    );

    const profile = await network.getAgentProfile();
    assert.equal(profile?.role, "Architecture implementation agent");
    assert.equal(profile?.environment.workspace, "github.com/acme/komnet");
    const directory = await network.listAgentDirectory();
    assert.equal(directory[0]?.role, "Architecture implementation agent");

    const { stdout } = await exec("git", [
      "--git-dir",
      remote,
      "show",
      `main:${agentProfilePath("alice-codex")}`,
    ]);
    assert.match(stdout, /current_focus: Implementing agent profiles/);
  });

  it("rejects local paths and credentials before they enter permanent history", async () => {
    await assert.rejects(
      () => network.publishAgentProfile({ workspace: "/Users/alice/private/payments" }),
      /not a local path/,
    );
    await assert.rejects(
      () =>
        network.publishAgentProfile({
          currentFocus: "Testing AKIAIOSFODNN7EXAMPLE",
        }),
      SecretDetectedError,
    );
  });
});
