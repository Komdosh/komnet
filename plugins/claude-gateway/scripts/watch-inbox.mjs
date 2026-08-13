#!/usr/bin/env node
// Event source for the relay gateway's Monitor.
//
// Emits ONE LINE per newly delivered komnet inbox item, and one per relay
// request dropped by a local session that could not reach the gateway over a
// cross-session socket. Every stdout line becomes a notification in the gateway
// session, so this script emits METADATA ONLY and never a message body.
//
// That restriction is the whole point. Bodies are written by agents on other
// machines. Announcing only `id room from needs priority` means the gateway
// reads remote text exactly once, through an explicit fetch, at a point where
// the relay skill has already framed it as data — instead of having it injected
// into context by a notification that arrived on its own.
//
// Three correctness properties this has to hold:
//
//   * Announce once. Dedup is by message id, so a `needs: human` item — which
//     an agent structurally cannot drain (ADR 0012) and which therefore sits in
//     the inbox indefinitely — is announced when it lands, not once per poll.
//
//   * Never go quiet on failure. A watcher that stops emitting when `komnet`
//     starts failing looks exactly like a network with nothing to say. So
//     consecutive failures emit their own line rather than exiting or being
//     swallowed on stderr.
//
//   * Poll is the mechanism; fs.watch is only an accelerator. The daemon writes
//     inbox files, so watching that directory turns a 15-second poll into a
//     sub-second one — but if the watch cannot be established (no daemon has
//     ever run, platform refuses recursive watches), the poll alone is still
//     correct.
//
// Env: KOMNET_HOME (default ~/.komnet), KOMNET_NETWORK, KOMNET_RELAY_POLL_MS.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const KOMNET_HOME = process.env.KOMNET_HOME || join(homedir(), ".komnet");
const NETWORK = process.env.KOMNET_NETWORK || "";
const POLL_MS = clampInt(process.env.KOMNET_RELAY_POLL_MS, 15000, 2000, 600000);

const GATEWAY_DIR = join(KOMNET_HOME, "gateway");
const REQUEST_DIR = join(GATEWAY_DIR, "requests");
const CLAIMED_DIR = join(GATEWAY_DIR, "claimed");
const INBOX_DIR = join(KOMNET_HOME, "inbox");

// Cap so a long-lived gateway cannot grow this without bound. Items leave the
// inbox when drained, so the live set is small; the cap only bounds the tail of
// parked `needs: human` ids.
const SEEN_CAP = 5000;
const seen = new Set();

let consecutiveFailures = 0;
let announcedFailure = false;
let polling = false;
let pollTimer = null;
let debounceTimer = null;

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Field values reach a notification line, so they get the same treatment the
// daemon's notifier gives text bound for AppleScript: no control characters, no
// newlines, no unbounded length. Ids and room names are protocol-shaped, but
// "should be" is not a validation strategy for input from another machine.
function clean(value, max = 80) {
  const s = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s || "-";
}

function emit(line) {
  process.stdout.write(`${line}\n`);
}

function remember(id) {
  seen.add(id);
  if (seen.size > SEEN_CAP) {
    // Set iteration is insertion-ordered, so this evicts oldest-first.
    const excess = seen.size - SEEN_CAP;
    let dropped = 0;
    for (const key of seen) {
      seen.delete(key);
      if (++dropped >= excess) break;
    }
  }
}

function runKomnet(args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("komnet", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, reason: `spawn-failed: ${error.message}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ ok: false, reason: `timeout-after-${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: `spawn-failed: ${error.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, reason: `exit-${code}: ${clean(stderr, 120)}` });
        return;
      }
      resolve({ ok: true, stdout });
    });
  });
}

// A local session that cannot reach the gateway over a cross-session socket
// drops a JSON file here instead. Claiming is a rename, which is atomic within
// a filesystem, so a request is handed to the gateway exactly once even if a
// poll and an fs.watch fire at the same moment.
function scanRequests() {
  if (!existsSync(REQUEST_DIR)) return;
  let entries;
  try {
    entries = readdirSync(REQUEST_DIR).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return;
  }

  for (const name of entries) {
    const from = join(REQUEST_DIR, name);
    const to = join(CLAIMED_DIR, name);
    try {
      mkdirSync(CLAIMED_DIR, { recursive: true });
      renameSync(from, to);
    } catch {
      continue; // Another pass claimed it, or it vanished. Either is fine.
    }

    // Only the declared origin reaches the line; the body stays on disk for the
    // gateway to read deliberately, exactly like a remote message body.
    let session = "-";
    let room = "-";
    try {
      const parsed = JSON.parse(readFileSync(to, "utf8"));
      session = clean(parsed.session, 60);
      room = clean(parsed.room, 60);
    } catch {
      session = "unparseable";
    }
    emit(`relay-request file=${clean(name, 60)} session=${session} room=${room}`);
  }
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    scanRequests();

    const args = ["inbox", "--json"];
    if (NETWORK) args.push("--network", NETWORK);
    const result = await runKomnet(args);

    if (!result.ok) {
      consecutiveFailures += 1;
      // One line after a sustained outage, then silence until it recovers —
      // enough for the gateway to notice and run `komnet doctor`, not enough to
      // flood the session while a laptop is asleep.
      if (consecutiveFailures >= 3 && !announcedFailure) {
        announcedFailure = true;
        emit(`relay-degraded consecutive-failures=${consecutiveFailures} reason=${clean(result.reason, 120)}`);
      }
      return;
    }

    if (announcedFailure) emit("relay-recovered komnet inbox reachable again");
    consecutiveFailures = 0;
    announcedFailure = false;

    let items;
    try {
      items = JSON.parse(result.stdout);
    } catch {
      emit("relay-degraded reason=inbox-json-unparseable");
      return;
    }
    if (!Array.isArray(items)) return;

    for (const item of items) {
      const id = String(item?.id ?? "");
      if (!id || seen.has(id)) continue;
      remember(id);
      emit(
        `komnet-inbox id=${clean(id, 40)} room=${clean(item?.room, 60)} from=${clean(item?.from, 60)}` +
          ` needs=${clean(item?.needs, 12)} priority=${clean(item?.priority, 12)} kind=${clean(item?.kind, 16)}` +
          ` thread=${clean(item?.thread, 40)}`,
      );
    }
  } finally {
    polling = false;
  }
}

function schedule() {
  clearTimeout(pollTimer);
  // Chained setTimeout, not setInterval: a slow `komnet inbox` must not let
  // polls stack up behind each other.
  pollTimer = setTimeout(async () => {
    await poll();
    schedule();
  }, POLL_MS);
}

function nudge() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    await poll();
  }, 300);
}

function tryWatch(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const w = watch(dir, { recursive: true }, () => nudge());
    w.on("error", () => {}); // Poll remains authoritative.
    return true;
  } catch {
    return false;
  }
}

const watchedInbox = tryWatch(INBOX_DIR);
const watchedRequests = tryWatch(REQUEST_DIR);

emit(
  `relay-armed poll=${POLL_MS}ms watch-inbox=${watchedInbox ? "on" : "off"}` +
    ` watch-requests=${watchedRequests ? "on" : "off"} home=${clean(KOMNET_HOME, 120)}`,
);

await poll();
schedule();
