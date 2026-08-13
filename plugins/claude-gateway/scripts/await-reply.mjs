#!/usr/bin/env node
// Wait, with a bound, for answers to come back from the network.
//
// Run this with Bash `run_in_background`: it exits as soon as it has what it
// was told to wait for, which produces exactly one completion notification. It
// is deliberately not a Monitor — a consult wants a single "the answers are
// here" wakeup, not a stream.
//
// It watches the gateway's reply directory rather than komnet itself, so the
// waiting session needs no komnet configuration and never touches the inbox.
// Draining is the gateway's job; a consulting session that drained would make
// the gateway think messages had been handled.
//
// Only used on the path where the gateway CANNOT push into this session. When
// the session is reachable the answer simply arrives as a cross-session message
// and nothing needs to wait.
//
// Usage: await-reply.mjs --key <projectKey> [--expect N] [--timeout SECONDS]
// Exit:  0 = got what it waited for · 3 = timed out · 2 = bad usage
//
// Env: KOMNET_HOME (default ~/.komnet)

import { mkdirSync, readdirSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const key = arg("key", "");
if (!/^[0-9]+$/.test(key)) {
  process.stderr.write("usage: await-reply.mjs --key <projectKey> [--expect N] [--timeout SECONDS]\n");
  process.exit(2);
}

const expect = Math.max(1, Number.parseInt(arg("expect", "1"), 10) || 1);
const timeoutSec = Math.min(3600, Math.max(10, Number.parseInt(arg("timeout", "900"), 10) || 900));

const KOMNET_HOME = process.env.KOMNET_HOME || join(homedir(), ".komnet");
const pendingDir = join(KOMNET_HOME, "gateway", "replies", key, "pending");

// Only the filename is ever printed, and the gateway restricts it to
// [A-Za-z0-9._-]. Re-filter anyway: this string ends up in a notification.
function safe(name) {
  return name.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 120) || "-";
}

const seen = new Set();

function scan() {
  let names;
  try {
    names = readdirSync(pendingDir).filter((n) => n.endsWith(".md"));
  } catch {
    return 0;
  }
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    // <id>--<room>--<from>.md
    const [id = "-", room = "-", from = "-"] = safe(n).replace(/\.md$/, "").split("--");
    process.stdout.write(`reply room=${room} from=${from} id=${id}\n`);
  }
  return seen.size;
}

function finish(code, message) {
  process.stdout.write(`${message}\n`);
  process.exit(code);
}

try {
  mkdirSync(pendingDir, { recursive: true });
} catch {
  // A gateway that has never run leaves nothing to watch; the poll below simply
  // finds nothing and this times out, which is the honest outcome.
}

if (scan() >= expect) finish(0, `await-reply: ${seen.size}/${expect} already waiting`);

const deadline = Date.now() + timeoutSec * 1000;

// fs.watch accelerates; the poll is what guarantees termination. A watch that
// silently stops firing must not turn a bounded wait into a hang.
try {
  const w = watch(pendingDir, () => {
    if (scan() >= expect) finish(0, `await-reply: got ${seen.size}/${expect}`);
  });
  w.on("error", () => {});
} catch {
  // Poll only.
}

const timer = setInterval(() => {
  if (scan() >= expect) finish(0, `await-reply: got ${seen.size}/${expect}`);
  if (Date.now() >= deadline) {
    clearInterval(timer);
    finish(3, `await-reply: timed out after ${timeoutSec}s with ${seen.size}/${expect}`);
  }
}, 2000);
