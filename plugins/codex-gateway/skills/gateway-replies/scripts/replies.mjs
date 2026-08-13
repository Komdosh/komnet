#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  let mode;
  let file;
  let projectDir = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--list") {
      if (mode !== undefined) fail("choose exactly one reply operation");
      mode = "list";
    } else if (arg === "--read" || arg === "--mark-delivered") {
      if (mode !== undefined) fail("choose exactly one reply operation");
      mode = arg.slice(2);
      file = argv[++index];
      if (file === undefined) fail(`${arg} requires a filename`);
    } else if (arg === "--project-dir") {
      const value = argv[++index];
      if (value === undefined) fail("--project-dir requires a path");
      projectDir = value;
    } else {
      fail(`unknown option: ${arg}`);
    }
  }
  return { mode: mode ?? "list", file, projectDir: resolve(projectDir) };
}

function projectKey(projectDir) {
  const result = spawnSync("cksum", [], { input: projectDir, encoding: "utf8" });
  if (result.status !== 0) fail("cannot compute project key: cksum is unavailable");
  const key = /^([0-9]+)\s/.exec(result.stdout)?.[1];
  if (key === undefined) fail("cannot compute project key: unexpected cksum output");
  return key;
}

function metadata(file) {
  const [id = "-", room = "-", from = "-"] = file.replace(/\.md$/, "").split("--");
  return { file, id, room, from };
}

function checkedFilename(value) {
  if (value !== basename(value) || !/^[A-Za-z0-9._-]+\.md$/.test(value)) {
    fail("reply filename must be a safe .md basename");
  }
  return value;
}

const args = parseArgs(process.argv.slice(2));
const komnetHome = resolve(process.env.KOMNET_HOME ?? join(homedir(), ".komnet"));
const root = join(komnetHome, "gateway", "replies", projectKey(args.projectDir));
const pendingDir = join(root, "pending");
const deliveredDir = join(root, "delivered");

if (args.mode === "list") {
  const files = existsSync(pendingDir)
    ? readdirSync(pendingDir)
        .filter((file) => /^[A-Za-z0-9._-]+\.md$/.test(file))
        .sort()
    : [];
  process.stdout.write(`${JSON.stringify(files.map(metadata), null, 2)}\n`);
  process.exit(0);
}

const file = checkedFilename(args.file);
const pendingPath = join(pendingDir, file);
if (!existsSync(pendingPath)) fail(`pending reply does not exist: ${file}`);

if (args.mode === "read") {
  process.stdout.write(
    `${JSON.stringify({ ...metadata(file), body: readFileSync(pendingPath, "utf8") }, null, 2)}\n`,
  );
  process.exit(0);
}

mkdirSync(deliveredDir, { recursive: true });
const deliveredPath = join(deliveredDir, file);
if (existsSync(deliveredPath)) fail(`delivered reply already exists: ${file}`);
renameSync(pendingPath, deliveredPath);
process.stdout.write(`${JSON.stringify({ state: "delivered", ...metadata(file) })}\n`);
