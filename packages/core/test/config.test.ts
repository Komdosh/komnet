import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  defaultIdentity,
  emptyConfig,
  loadConfig,
  normalizeAgentTool,
  normalizeProjectRole,
  resolveProjectBinding,
  saveConfig,
} from "../src/index.ts";

describe("project-scoped network and role bindings", () => {
  let tmp: string;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "komnet-config-"));
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("selects the most specific parent without matching a sibling prefix", () => {
    const root = resolve(tmp, "workspace");
    const nested = resolve(root, "mobile");
    const config = emptyConfig(defaultIdentity({ id: "alice-codex" }));
    config.projects[root] = { network: "company", role: "Platform engineer" };
    config.projects[nested] = { network: "mobile", role: "Mobile engineer" };

    assert.deepEqual(resolveProjectBinding(config, join(nested, "app", "src")), {
      path: nested,
      network: "mobile",
      role: "Mobile engineer",
    });
    assert.deepEqual(resolveProjectBinding(config, join(root, "backend")), {
      path: root,
      network: "company",
      role: "Platform engineer",
    });
    assert.equal(resolveProjectBinding(config, `${root}-other`), null);
  });

  it("normalizes roles and rejects values unsuitable for an agent profile", () => {
    assert.equal(normalizeProjectRole("  Architecture\n  reviewer  "), "Architecture reviewer");
    assert.throws(() => normalizeProjectRole("   "), /must not be empty/);
    assert.throws(() => normalizeProjectRole("x".repeat(121)), /at most 120/);
  });

  it("normalizes tool identity before it reaches shared cards and profiles", () => {
    assert.equal(normalizeAgentTool("  claude-code\n"), "claude-code");
    assert.throws(() => normalizeAgentTool("   "), /must not be empty/);
    assert.throws(() => normalizeAgentTool("x".repeat(65)), /at most 64/);
  });

  it("round-trips bindings in machine-local config", async () => {
    const path = join(tmp, "config.yaml");
    const project = resolve(tmp, "project-a");
    const config = emptyConfig(defaultIdentity({ id: "alice-codex" }));
    config.networks["architecture"] = {
      id: "architecture",
      remote: "git@example.test:komnet/architecture.git",
      subscriptions: [],
    };
    config.defaultNetwork = "architecture";
    config.projects[project] = { network: "architecture", role: "Architecture reviewer" };

    await saveConfig(path, config);
    const loaded = await loadConfig(path);
    assert.deepEqual(loaded?.projects, config.projects);
    assert.match(await readFile(path, "utf8"), /Architecture reviewer/);
  });
});
