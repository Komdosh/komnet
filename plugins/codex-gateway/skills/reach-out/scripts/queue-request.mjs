#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined) {
      fail(
        "usage: queue-request.mjs --room <room> --body <question> [--session <label>] [--project-dir <path>]",
      );
    }
    if (values.has(key)) fail(`duplicate option: ${key}`);
    values.set(key, value);
  }
  for (const key of values.keys()) {
    if (!["--room", "--body", "--session", "--project-dir"].includes(key)) {
      fail(`unknown option: ${key}`);
    }
  }
  return values;
}

function projectKey(projectDir) {
  const result = spawnSync("cksum", [], { input: projectDir, encoding: "utf8" });
  if (result.status !== 0) fail("cannot compute project key: cksum is unavailable");
  const key = /^([0-9]+)\s/.exec(result.stdout)?.[1];
  if (key === undefined) fail("cannot compute project key: unexpected cksum output");
  return key;
}

function safeSession(value) {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
  return normalized.length > 0 ? normalized : "codex";
}

const args = parseArgs(process.argv.slice(2));
const room = args.get("--room")?.trim();
const body = args.get("--body")?.trim();
const reservedRooms = new Set(["head", "main", "master", "komnet", "refs"]);
if (
  room === undefined ||
  !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(room) ||
  reservedRooms.has(room)
) {
  fail("--room must be a lowercase, dash-separated room id");
}
if (body === undefined || body.length === 0) fail("--body must not be empty");

const projectDir = resolve(args.get("--project-dir") ?? process.cwd());
const session = safeSession(args.get("--session") ?? `codex-${basename(projectDir)}`);
const komnetHome = resolve(process.env.KOMNET_HOME ?? join(homedir(), ".komnet"));
const requestDir = join(komnetHome, "gateway", "requests");
if (!existsSync(requestDir)) {
  fail(`gateway request directory does not exist: ${requestDir}`);
}

const queuedAt = new Date().toISOString();
const sortable = queuedAt.replace(/[-:.TZ]/g, "");
const finalName = `${sortable}-${randomUUID()}.json`;
const finalPath = join(requestDir, finalName);
const temporaryPath = `${finalPath}.tmp`;
const payload = {
  session,
  replyKey: projectKey(projectDir),
  room,
  body,
  queuedAt,
};

try {
  writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, finalPath);
} catch (error) {
  try {
    unlinkSync(temporaryPath);
  } catch {
    // Nothing to clean up.
  }
  fail(`cannot queue gateway request: ${error instanceof Error ? error.message : String(error)}`);
}

process.stdout.write(
  `${JSON.stringify({ state: "queued", file: finalName, room, replyKey: payload.replyKey, session })}\n`,
);
