#!/usr/bin/env node
/**
 * Build the self-contained `komnet` executable (ADR 0011).
 *
 * Bundle the CLI to a single CommonJS file, turn it into a SEA blob, inject
 * that blob into a copy of the Node runtime. The result embeds its own
 * runtime — the entire point, since a daemon riding the user's `nvm`-managed
 * Node dies silently the moment they switch version.
 *
 * SEA cannot cross-compile: each platform's binary is built on that platform.
 *
 * Usage:
 *   node scripts/build-binary.mjs [--out dist-bin] [--name komnet]
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The marker postject overwrites to mark a Node binary as carrying a SEA blob.
 * Split so this file does not itself contain the sentinel — a build script that
 * matched its own source would confuse the detection below.
 */
const FUSE = ["NODE_SEA_FUSE", "fce680ab2cc467b6e072b8b5df1996b2"].join("_");

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

const outDir = resolve(root, arg("--out", "dist-bin"));
const binName = arg("--name", process.platform === "win32" ? "komnet.exe" : "komnet");
const work = join(outDir, ".sea");
const bundlePath = join(work, "komnet.cjs");
const blobPath = join(work, "komnet.blob");
const configPath = join(work, "sea-config.json");
const outPath = join(outDir, binName);

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });

/**
 * Whether a Node binary can host a SEA blob.
 *
 * Distro and Homebrew builds are often a small launcher linked against a shared
 * libnode; the fuse lives in the library, not the launcher, so injection fails
 * with a confusing "could not find the sentinel". Detect it up front.
 */
function isSeaCapable(path) {
  try {
    if (statSync(path).size < 10 * 1024 * 1024) return false;
    return readFileSync(path).includes(FUSE);
  } catch {
    return false;
  }
}

/** Download an official static Node build to use as the SEA base. */
function fetchOfficialNode(version) {
  const platform = { darwin: "darwin", linux: "linux" }[process.platform];
  const arch = { arm64: "arm64", x64: "x64" }[process.arch];
  if (platform === undefined || arch === undefined) {
    throw new Error(
      `no SEA-capable Node available for ${process.platform}/${process.arch}. ` +
        `Install the official build from nodejs.org and re-run.`,
    );
  }

  const name = `node-${version}-${platform}-${arch}`;
  const cached = join(work, name, "bin", "node");
  if (existsSync(cached)) return cached;

  const url = `https://nodejs.org/dist/${version}/${name}.tar.gz`;
  console.log(`→ host Node cannot host a SEA blob; fetching ${url}`);
  sh("curl", ["-fsSL", "-o", join(work, `${name}.tar.gz`), url]);
  sh("tar", ["-xzf", join(work, `${name}.tar.gz`), "-C", work]);
  if (!existsSync(cached)) throw new Error(`extraction did not produce ${cached}`);
  return cached;
}

rmSync(join(outDir, binName), { force: true });
mkdirSync(work, { recursive: true });

const entry = join(root, "packages", "cli", "dist", "bin.js");
if (!existsSync(entry)) throw new Error(`${entry} is missing — run 'pnpm build' first`);

console.log("→ bundling the CLI to a single CommonJS file");
sh(process.execPath, [
  join(root, "node_modules", "esbuild", "bin", "esbuild"),
  entry,
  "--bundle",
  "--platform=node",
  "--target=node26",
  "--format=cjs",
  // Node builtins stay external; everything else (yaml, workspace packages) is
  // inlined so the binary performs no module resolution at runtime.
  "--external:node:*",
  `--outfile=${bundlePath}`,
  "--log-level=warning",
]);

console.log("→ generating the SEA blob");
writeFileSync(
  configPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ),
);
sh(process.execPath, ["--experimental-sea-config", configPath]);

const base = isSeaCapable(process.execPath)
  ? process.execPath
  : fetchOfficialNode(process.version);

console.log(`→ copying the Node runtime (${base})`);
mkdirSync(outDir, { recursive: true });
copyFileSync(base, outPath);
chmodSync(outPath, 0o755);

// macOS refuses to run a signed binary that has been modified, so the existing
// signature comes off before injection and an ad-hoc one goes on afterwards.
const isMac = process.platform === "darwin";
if (isMac) {
  console.log("→ removing the existing code signature");
  try {
    sh("codesign", ["--remove-signature", outPath]);
  } catch {
    console.log("  (none present)");
  }
}

console.log("→ injecting the blob");
sh(process.execPath, [
  join(root, "node_modules", "postject", "dist", "cli.js"),
  outPath,
  "NODE_SEA_BLOB",
  blobPath,
  "--sentinel-fuse",
  FUSE,
  ...(isMac ? ["--macho-segment-name", "NODE_SEA"] : []),
]);

if (isMac) {
  console.log("→ re-signing (ad-hoc)");
  sh("codesign", ["--sign", "-", outPath]);
}

console.log("→ verifying the binary runs");
const reported = execFileSync(outPath, ["--version"], { encoding: "utf8" }).trim();
const megabytes = (statSync(outPath).size / 1024 / 1024).toFixed(1);
console.log(`\n✓ ${outPath} — komnet ${reported} (${megabytes} MB)`);
