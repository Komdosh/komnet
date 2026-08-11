#!/usr/bin/env node
/**
 * Decide the next version from Conventional Commits, and apply it everywhere.
 *
 *   node scripts/release-version.mjs --check            → JSON decision, no writes
 *   node scripts/release-version.mjs --apply 0.2.0      → write the version everywhere
 *
 * The load-bearing rule is **"releasable"**: a release happens only when the
 * commits since the last tag actually change behaviour. Without that, every
 * README typo would burn a version number — and npm publishes are permanent,
 * so a burned number can never be reclaimed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every file that carries the version. The release guard checks these agree. */
export const VERSION_SITES = [
  { file: "packages/protocol/package.json", kind: "json" },
  { file: "packages/core/package.json", kind: "json" },
  { file: "packages/daemon/package.json", kind: "json" },
  { file: "packages/mcp/package.json", kind: "json" },
  { file: "packages/cli/package.json", kind: "json" },
  {
    file: "packages/cli/src/main.ts",
    kind: "const",
    pattern: /(export const VERSION = ")([^"]+)(")/,
  },
  {
    file: "packages/mcp/src/server.ts",
    kind: "const",
    pattern: /(export const MCP_SERVER_VERSION = ")([^"]+)(")/,
  },
];

const git = (...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    // `describe` with no tags writes "fatal: No names found" to stderr on a
    // path we handle; letting it through makes a normal state look like a fault.
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

export function currentVersion() {
  return JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;
}

function lastTag() {
  try {
    return git("describe", "--tags", "--abbrev=0", "--match", "v*");
  } catch {
    return null;
  }
}

/**
 * Classify one commit subject/body.
 *
 * `feat!:` or a `BREAKING CHANGE:` footer is breaking; `feat:` is a feature;
 * `fix:`/`perf:` is a patch. Everything else — docs, chore, ci, test, style,
 * refactor, and any non-conventional subject — is deliberately NOT releasable.
 */
export function classify(message) {
  const subject = message.split("\n")[0] ?? "";
  const match = /^(\w+)(\([^)]*\))?(!)?:\s/.exec(subject);
  const breaking = match?.[3] === "!" || /^BREAKING[ -]CHANGE:/m.test(message);
  if (breaking) return "breaking";
  if (match === null) return "none";
  const type = match[1].toLowerCase();
  if (type === "feat") return "feature";
  if (type === "fix" || type === "perf") return "patch";
  return "none";
}

/**
 * Apply a bump.
 *
 * While the major is 0, a breaking change moves the MINOR — `0.1.0 → 0.2.0`,
 * not `1.0.0`. Reaching 1.0 is a deliberate act, not something a `feat!:`
 * should trigger by accident.
 */
export function bumpVersion(version, level) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (level === "breaking") {
    return major === 0 ? `0.${String(minor + 1)}.0` : `${String(major + 1)}.0.0`;
  }
  if (level === "feature") return `${String(major)}.${String(minor + 1)}.0`;
  if (level === "patch") return `${String(major)}.${String(minor)}.${String(patch + 1)}`;
  return version;
}

const RANK = { none: 0, patch: 1, feature: 2, breaking: 3 };

/**
 * What the AUTOMATIC path does with a detected level.
 *
 * The automatic path only ever bumps the PATCH. A `feat:` releases as a patch
 * rather than a minor, because a minor signals scope to users and is worth
 * choosing deliberately rather than inheriting from a commit prefix.
 *
 * A breaking change returns `"manual"` — it refuses to auto-release at all.
 * Shipping one as a patch would actively mislead, since a patch is the one
 * thing users assume is safe to take.
 *
 * Pure, so the policy is testable without a git history that happens to
 * contain the right commits.
 */
export function autoPolicy(level) {
  if (level === "none") return "none";
  if (level === "breaking") return "manual";
  return "patch";
}

export function decide() {
  const tag = lastTag();
  const range = tag === null ? "HEAD" : `${tag}..HEAD`;
  const raw = git("log", range, "--no-merges", "--format=%H%x1f%B%x1e");

  const commits = raw
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [sha, body = ""] = entry.split("\x1f");
      return { sha: sha.slice(0, 7), subject: body.split("\n")[0] ?? "", level: classify(body) };
    });

  let level = "none";
  for (const commit of commits) {
    if (RANK[commit.level] > RANK[level]) level = commit.level;
  }

  const auto = autoPolicy(level);
  const current = currentVersion();

  return {
    lastTag: tag,
    current,
    /** Highest level detected in the commits — informational. */
    level,
    /** What the automatic path will do: "patch", "manual", or "none". */
    auto,
    next: auto === "patch" ? bumpVersion(current, "patch") : current,
    releasable: auto === "patch",
    requiresManual: auto === "manual",
    reason:
      auto === "patch"
        ? `${level} change → patch release`
        : auto === "manual"
          ? "breaking change detected — run Auto Release manually with an explicit version"
          : "nothing releasable since the last tag",
    commits,
    releasableCommits: commits.filter((c) => c.level !== "none"),
  };
}

function setJsonVersion(file, version) {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  // Rewrite only the top-level "version" line, so formatting and key order
  // survive untouched — a JSON round-trip would reorder or reformat.
  const next = text.replace(/^(\s*"version":\s*")([^"]+)(")/m, `$1${version}$3`);
  if (next === text) throw new Error(`${file}: no top-level "version" field to update`);
  writeFileSync(path, next);
}

function setConstVersion(file, pattern, version) {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  if (!pattern.test(text)) throw new Error(`${file}: version constant not found`);
  writeFileSync(path, text.replace(pattern, `$1${version}$3`));
}

function updateChangelog(version, decision, today) {
  const path = join(root, "CHANGELOG.md");
  const text = readFileSync(path, "utf8");
  const marker = "## [Unreleased]";
  const index = text.indexOf(marker);
  if (index === -1) throw new Error("CHANGELOG.md has no '## [Unreleased]' section");

  const after = text.slice(index + marker.length);
  const nextHeading = after.search(/\n## \[/);
  const carried = (nextHeading === -1 ? after : after.slice(0, nextHeading)).trim();

  const grouped = { breaking: [], feature: [], patch: [] };
  for (const commit of decision.releasableCommits) {
    grouped[commit.level].push(`- ${commit.subject} (${commit.sha})`);
  }
  const sections = [
    grouped.breaking.length > 0 ? `### Breaking\n\n${grouped.breaking.join("\n")}` : "",
    grouped.feature.length > 0 ? `### Added\n\n${grouped.feature.join("\n")}` : "",
    grouped.patch.length > 0 ? `### Fixed\n\n${grouped.patch.join("\n")}` : "",
  ].filter((section) => section !== "");

  // Anything hand-written under [Unreleased] is carried into the release —
  // a human's prose is better than a list of commit subjects, so it wins.
  const body = carried === "" || carried === "Nothing yet." ? sections.join("\n\n") : carried;

  const release = `## [${version}] — ${today}\n\n${body}\n`;
  const rebuilt =
    text.slice(0, index) +
    `${marker}\n\nNothing yet.\n\n` +
    release +
    (nextHeading === -1 ? "" : after.slice(nextHeading + 1));

  writeFileSync(path, rebuilt);
}

function apply(version, today) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a semver version: ${version}`);
  for (const site of VERSION_SITES) {
    if (site.kind === "json") setJsonVersion(site.file, version);
    else setConstVersion(site.file, site.pattern, version);
  }
  updateChangelog(version, decide(), today);
}

// ------------------------------------------------------------------- cli
// Guarded so the module can be imported by tests without running a command.

const args = process.argv.slice(2);
const invokedDirectly = process.argv[1] !== undefined && import.meta.filename === process.argv[1];

if (!invokedDirectly) {
  // imported — export only
} else if (args.includes("--check")) {
  const decision = decide();
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
} else if (args.includes("--apply")) {
  const version = args[args.indexOf("--apply") + 1];
  const dateArg = args.indexOf("--date");
  const today = dateArg === -1 ? new Date().toISOString().slice(0, 10) : args[dateArg + 1];
  apply(version, today);
  process.stdout.write(`applied ${version} to ${String(VERSION_SITES.length)} files + CHANGELOG\n`);
} else if (args.includes("--verify")) {
  // Used by the release guard: every site must already agree.
  const expected = args[args.indexOf("--verify") + 1] ?? currentVersion();
  const wrong = [];
  for (const site of VERSION_SITES) {
    const text = readFileSync(join(root, site.file), "utf8");
    const found =
      site.kind === "json"
        ? /^\s*"version":\s*"([^"]+)"/m.exec(text)?.[1]
        : site.pattern.exec(text)?.[2];
    if (found !== expected) wrong.push(`${site.file}: ${String(found)} != ${expected}`);
  }
  if (wrong.length > 0) {
    process.stderr.write(`version drift:\n  ${wrong.join("\n  ")}\n`);
    process.exit(1);
  }
  process.stdout.write(`all ${String(VERSION_SITES.length)} version sites agree on ${expected}\n`);
} else {
  process.stderr.write(
    "usage: release-version.mjs --check | --apply <version> | --verify [version]\n",
  );
  process.exit(2);
}
