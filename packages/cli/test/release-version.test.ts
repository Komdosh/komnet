import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const exec = promisify(execFile);
const SCRIPT = join(import.meta.dirname, "..", "..", "..", "scripts", "release-version.mjs");

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
const mod = (await import(SCRIPT)) as {
  classify: (message: string) => string;
  bumpVersion: (version: string, level: string) => string;
  autoPolicy: (level: string) => string;
  replaceJsonVersion: (text: string, version: string) => string;
  buildChangelog: (
    text: string,
    version: string,
    decision: { releasableCommits: { subject: string; sha: string; level: string }[] },
    today: string,
  ) => string;
  VERSION_SITES: { file: string }[];
};

describe("release version decision", () => {
  it("treats only behaviour-changing commits as releasable", () => {
    // The safety property: a docs typo must never burn a version number,
    // because an npm publish cannot be taken back.
    assert.equal(mod.classify("feat: add presence"), "feature");
    assert.equal(mod.classify("fix: close sockets on shutdown"), "patch");
    assert.equal(mod.classify("perf: cache the room index"), "patch");

    for (const subject of [
      "docs: fix a typo",
      "chore: bump deps",
      "ci: run on macos",
      "test: cover the scanner",
      "refactor: rename a helper",
      "style: reformat",
      "Merge branch 'x'",
      "Bump actions/checkout from 4 to 7",
      "some non-conventional subject",
    ]) {
      assert.equal(mod.classify(subject), "none", `expected '${subject}' to be unreleasable`);
    }
  });

  it("detects breaking changes in both notations", () => {
    assert.equal(mod.classify("feat!: drop v1 protocol"), "breaking");
    assert.equal(mod.classify("feat(protocol)!: drop v1"), "breaking");
    assert.equal(
      mod.classify("feat: something\n\nBREAKING CHANGE: the wire format moved"),
      "breaking",
    );
    // A breaking footer promotes even an otherwise-unreleasable type.
    assert.equal(mod.classify("chore: x\n\nBREAKING CHANGE: y"), "breaking");
  });

  it("keeps a breaking change inside 0.x on the minor", () => {
    // Reaching 1.0 is a deliberate act, not something a `feat!:` triggers by
    // accident on a pre-1.0 project.
    assert.equal(mod.bumpVersion("0.1.0", "breaking"), "0.2.0");
    assert.equal(mod.bumpVersion("0.4.2", "breaking"), "0.5.0");
    assert.equal(mod.bumpVersion("1.4.2", "breaking"), "2.0.0");
  });

  it("bumps features and fixes conventionally", () => {
    assert.equal(mod.bumpVersion("0.1.0", "feature"), "0.2.0");
    assert.equal(mod.bumpVersion("0.1.3", "patch"), "0.1.4");
    assert.equal(mod.bumpVersion("1.2.3", "feature"), "1.3.0");
    assert.equal(mod.bumpVersion("1.2.3", "none"), "1.2.3");
  });

  it("knows every file that carries the version", () => {
    // Drift here is how a binary ends up reporting a version that never
    // existed, which poisons every later bug report.
    const files = mod.VERSION_SITES.map((s) => s.file);
    for (const expected of [
      "packages/protocol/package.json",
      "packages/core/package.json",
      "packages/daemon/package.json",
      "packages/mcp/package.json",
      "packages/cli/package.json",
      "plugins/codex/.codex-plugin/plugin.json",
      "plugins/codex-gateway/.codex-plugin/plugin.json",
      "packages/cli/src/main.ts",
      "packages/mcp/src/server.ts",
    ]) {
      assert.ok(files.includes(expected), `VERSION_SITES is missing ${expected}`);
    }
  });

  it("re-applying the version already in the tree is a no-op, not a failure", () => {
    // This is the FIRST-release case, and it broke v0.1.0: every version site is
    // authored at the version being cut, so `--apply 0.1.0` legitimately changes
    // nothing. The old guard used "the text did not change" as its proxy for
    // "there is no version field" and threw on a healthy tree, before any tag
    // was pushed. Absence of the field is the error; an unchanged file is not.
    const json = '{\n  "name": "x",\n  "version": "0.1.0"\n}\n';
    assert.equal(mod.replaceJsonVersion(json, "0.1.0"), json);
    assert.equal(
      mod.replaceJsonVersion(json, "0.2.0"),
      '{\n  "name": "x",\n  "version": "0.2.0"\n}\n',
    );
  });

  it("still refuses a JSON file that carries no version field", () => {
    // The guard has to keep catching a site that silently stopped carrying the
    // version — that is how a binary ends up reporting a version that never was.
    assert.throws(
      () => mod.replaceJsonVersion('{\n  "name": "x"\n}\n', "0.1.0"),
      /no top-level "version" field/,
    );
  });

  it("leaves a blank line before the previous release heading", () => {
    // Prettier requires a blank line before a heading, and the release workflow
    // runs `pnpm fmt:check` against the BUMPED tree. Omitting it fails the gate
    // after the version is applied but before the tag is pushed, so no release
    // can complete — which is exactly how v0.1.0 failed.
    const text =
      "# Changelog\n\n## [Unreleased]\n\nNew stuff.\n\n## [0.0.9] — 2026-01-01\n\nOld.\n";
    const next = mod.buildChangelog(text, "0.1.0", { releasableCommits: [] }, "2026-08-11");

    assert.match(
      next,
      /New stuff\.\n\n## \[0\.0\.9\]/,
      "no blank line before the previous release",
    );
    assert.match(next, /## \[Unreleased\]\n\nNothing yet\.\n\n## \[0\.1\.0\] — 2026-08-11\n/);
    assert.ok(next.includes("## [0.0.9] — 2026-01-01\n\nOld.\n"), "previous release was mangled");
  });

  it("carries hand-written Unreleased prose into the release, not commit subjects", () => {
    const authored = "# C\n\n## [Unreleased]\n\n### Added\n\n- A real sentence.\n";
    const next = mod.buildChangelog(
      authored,
      "0.1.0",
      { releasableCommits: [{ subject: "feat: x", sha: "abc1234", level: "feature" }] },
      "2026-08-11",
    );
    assert.ok(next.includes("- A real sentence."), "dropped the human's prose");
    assert.ok(!next.includes("feat: x (abc1234)"), "commit subjects overrode the human's prose");
  });

  it("--verify passes on the committed tree", async () => {
    const { stdout } = await exec(process.execPath, [SCRIPT, "--verify"]);
    assert.match(stdout, /version sites agree/);
  });

  it("--verify fails loudly on a mismatch", async () => {
    await assert.rejects(
      () => exec(process.execPath, [SCRIPT, "--verify", "9.9.9"]),
      (error: { stderr?: string }) => /version drift/.test(error.stderr ?? ""),
    );
  });

  it("--check emits a machine-readable decision", async () => {
    const { stdout } = await exec(process.execPath, [SCRIPT, "--check"]);
    const decision = JSON.parse(stdout) as {
      current: string;
      next: string;
      releasable: boolean;
      requiresManual: boolean;
      level: string;
      auto: string;
      reason: string;
    };
    assert.match(decision.current, /^\d+\.\d+\.\d+$/);
    assert.match(decision.next, /^\d+\.\d+\.\d+$/);
    assert.equal(typeof decision.releasable, "boolean");
    assert.ok(["none", "patch", "feature", "breaking"].includes(decision.level));
    assert.ok(["none", "patch", "manual"].includes(decision.auto));
    assert.ok(decision.reason.length > 0);
  });

  it("only ever auto-bumps the patch, whatever the commits say", () => {
    // A `feat:` ships as a patch: a minor signals scope to users and is worth
    // choosing deliberately rather than inheriting from a commit prefix.
    assert.equal(mod.autoPolicy("feature"), "patch");
    assert.equal(mod.autoPolicy("patch"), "patch");
    assert.equal(mod.autoPolicy("none"), "none");
  });

  it("refuses to auto-release a breaking change", () => {
    // Shipping a breaking change as a patch would actively mislead: a patch is
    // the one thing users assume is safe to take. It stops and asks instead.
    assert.equal(mod.autoPolicy("breaking"), "manual");
    assert.equal(mod.classify("feat!: drop v1 protocol"), "breaking");
    assert.equal(mod.autoPolicy(mod.classify("feat!: drop v1 protocol")), "manual");
    assert.equal(
      mod.autoPolicy(mod.classify("chore: x\n\nBREAKING CHANGE: y")),
      "manual",
      "a breaking footer must stop the pipeline even on an otherwise-quiet type",
    );
  });

  it("an automatic release never moves the major or minor", () => {
    for (const version of ["0.1.0", "0.9.9", "1.4.2"]) {
      const next = mod.bumpVersion(version, "patch");
      assert.equal(
        next.split(".").slice(0, 2).join("."),
        version.split(".").slice(0, 2).join("."),
        `patch bump of ${version} moved the minor`,
      );
    }
  });
});
