import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { Layout } from "@kom-net/core";

import { Daemon } from "../src/daemon.ts";
import { DaemonClient } from "../src/client.ts";
import { LineFramer, encode, isMethod } from "../src/protocol.ts";
import { createNotifier, sanitize, shouldNotify } from "../src/notify.ts";
import { renderUnit } from "../src/supervisor.ts";

const exec = promisify(execFile);

process.env["GIT_AUTHOR_NAME"] = "kom-net test";
process.env["GIT_AUTHOR_EMAIL"] = "test@kom-net.invalid";
process.env["GIT_COMMITTER_NAME"] = "kom-net test";
process.env["GIT_COMMITTER_EMAIL"] = "test@kom-net.invalid";
process.env["NO_COLOR"] = "1";

const CLI = join(import.meta.dirname, "..", "..", "cli", "dist", "bin.js");

let tmp: string;
let remote: string;
let aliceHome: string;
let bobHome: string;

async function komnet(home: string, ...args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await exec(process.execPath, [CLI, ...args], {
      env: { ...process.env, KOMNET_HOME: home, NO_COLOR: "1" },
    });
    return { code: 0, stdout };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** Poll until `check` passes, so tests never depend on a fixed sleep. */
async function waitFor<T>(
  check: () => Promise<T | null>,
  what: string,
  timeoutMs = 25_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== null) return result;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "komnet-daemon-"));
  remote = join(tmp, "transport.git");
  aliceHome = join(tmp, "alice");
  bobHome = join(tmp, "bob");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);

  assert.equal(
    (
      await komnet(
        aliceHome,
        "init",
        "--repo",
        remote,
        "--network",
        "acme",
        "--agent",
        "alice-cursor",
      )
    ).code,
    0,
  );
  assert.equal((await komnet(aliceHome, "room", "create", "architecture")).code, 0);
  assert.equal(
    (await komnet(bobHome, "init", "--repo", remote, "--network", "acme", "--agent", "bob-codex"))
      .code,
    0,
  );
  assert.equal((await komnet(bobHome, "room", "join", "architecture")).code, 0);
});

after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("shutdown during an in-flight sync", () => {
  it("does not leave an unhandled rejection behind", async () => {
    // Regression: `tick()` resumed after its await and read the network's
    // StateDb, which `Daemon.stop()` had already closed — "database is not
    // open", thrown from inside a `void this.tick()`. It surfaced as an
    // intermittent EXTRA failing test in full-suite runs, because Node reports
    // an error thrown outside a test as a synthetic one.
    const home = join(tmp, "shutdown-race");
    await komnet(home, "init", "--repo", remote, "--network", "acme", "--agent", "race-agent");
    await komnet(home, "room", "join", "architecture");

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);

    const layout = new Layout(home);
    const daemon = new Daemon({ layout, notifier: "none", log: () => undefined });
    try {
      await daemon.start();
      // Stop while the first tick is still inside `network.sync()`.
      await sleep(60);
      await daemon.stop();
      // Let the in-flight tick resume past its await.
      await sleep(1_500);

      const reasons = rejections.map((r) =>
        r instanceof Error ? `${r.message}\n${r.stack ?? ""}` : String(r),
      );
      assert.deepEqual(
        reasons,
        [],
        `stopping mid-sync must not throw from a detached timer. Got:\n${reasons.join("\n---\n")}`,
      );
    } finally {
      process.off("unhandledRejection", onRejection);
      await daemon.stop().catch(() => undefined);
    }
  });
});

describe("IPC framing", () => {
  it("reassembles messages split across chunks", () => {
    const framer = new LineFramer();
    assert.deepEqual(framer.push('{"a":'), []);
    assert.deepEqual(framer.push("1}\n"), ['{"a":1}']);
  });

  it("splits several messages arriving in one chunk", () => {
    const framer = new LineFramer();
    assert.deepEqual(framer.push('{"a":1}\n{"b":2}\n'), ['{"a":1}', '{"b":2}']);
  });

  it("caps line length so a peer cannot exhaust memory", () => {
    const framer = new LineFramer(64);
    assert.throws(() => framer.push("x".repeat(128)), /maximum length/);
  });

  it("round-trips through encode", () => {
    const line = encode({ id: 7, ok: true, result: { x: 1 } });
    assert.ok(line.endsWith("\n"));
    assert.deepEqual(new LineFramer().push(line), [line.trim()]);
  });

  it("recognises only known methods", () => {
    assert.ok(isMethod("status"));
    assert.ok(!isMethod("rm -rf"));
  });
});

describe("notifications", () => {
  it("strips characters that could escape into AppleScript", () => {
    // A message body is written by another machine, and osascript treats its
    // argument as source — an unescaped quote would be executable.
    const nasty = 'hi"; do shell script "rm -rf /"; --';
    const clean = sanitize(nasty);
    assert.doesNotMatch(clean, /["'\\`$]/);
    assert.doesNotMatch(clean, /\n/);
  });

  it("truncates long bodies", () => {
    assert.ok(sanitize("x".repeat(500)).length <= 180);
  });

  it("interrupts only when someone is actually blocked", () => {
    const base = {
      needs: "none",
      priority: "normal",
      directlyMentioned: false,
      sessionLive: false,
    };
    assert.ok(shouldNotify({ ...base, needs: "human" }), "a human decision always notifies");
    assert.ok(shouldNotify({ ...base, priority: "blocking" }));
    assert.ok(shouldNotify({ ...base, directlyMentioned: true }));
    assert.ok(
      !shouldNotify({ ...base, directlyMentioned: true, sessionLive: true }),
      "a live session drains on its own — interrupting adds nothing",
    );
    assert.ok(!shouldNotify(base), "ordinary room chatter is recorded, not announced");
  });

  it("writes to a file sink without needing a desktop", async () => {
    const path = join(tmp, "NOTICE.md");
    await createNotifier("file", path).notify({ title: "t", body: "b" });
    assert.match(await readFile(path, "utf8"), /t — b/);
  });
});

describe("supervisor units", () => {
  it("renders a launchd agent that restarts on failure", () => {
    const plist = renderUnit("launchd", "/usr/bin/node", ["/opt/komnetd"]);
    assert.match(plist, /<key>Label<\/key><string>dev\.komnet\.daemon<\/string>/);
    assert.match(plist, /<string>\/opt\/komnetd<\/string>/);
    assert.match(plist, /KeepAlive/);
  });

  it("escapes XML so a path cannot break the plist", () => {
    const plist = renderUnit("launchd", "/usr/bin/node", ["/tmp/a&b<c>"]);
    assert.match(plist, /a&amp;b&lt;c&gt;/);
  });

  it("renders a user-level systemd unit, never a system one", () => {
    const unit = renderUnit("systemd", "/usr/bin/node", ["/opt/komnetd"]);
    assert.match(unit, /WantedBy=default\.target/, "must be a user unit");
    assert.doesNotMatch(unit, /User=root/);
    assert.match(unit, /Restart=on-failure/);
  });
});

describe("a running daemon", () => {
  let daemon: Daemon;
  let layout: Layout;

  before(async () => {
    layout = new Layout(bobHome);
    daemon = new Daemon({ layout, notifier: "none", log: () => undefined });
    await daemon.start();
  });

  after(async () => {
    await daemon.stop();
  });

  it("answers on a socket that only its owner can read", async () => {
    assert.ok(await DaemonClient.isAlive(layout.socketPath));
    const mode = (await stat(layout.socketPath)).mode & 0o777;
    assert.equal(mode, 0o600, "filesystem permissions ARE the authentication");
  });

  it("refuses to start a second daemon on the same home", async () => {
    const second = new Daemon({ layout, notifier: "none", log: () => undefined });
    await assert.rejects(() => second.start(), /already running/);
  });

  it("delivers messages with no agent running and no explicit sync", async () => {
    // The reason the daemon exists (ADR 0006): work is staged while the agent
    // is closed, so it is there the moment a session opens.
    assert.equal(
      (
        await komnet(
          aliceHome,
          "send",
          "architecture",
          "daemon delivery works",
          "--mention",
          "bob-codex",
        )
      ).code,
      0,
    );

    const item = await waitFor(async () => {
      const client = await DaemonClient.tryConnect(layout.socketPath);
      if (client === null) return null;
      try {
        const inbox = await client.request<{ id: string; body: string }[]>("inbox");
        return inbox.find((i) => i.body.includes("daemon delivery works")) ?? null;
      } finally {
        client.close();
      }
    }, "the daemon to deliver a message on its own");

    assert.ok(item.id.length > 0);
  });

  it("reports its own state through status", async () => {
    const client = await DaemonClient.connect(layout.socketPath);
    try {
      const status = await client.request<{
        agentId: string;
        daemon: { sessionLive: boolean; loopRunning: boolean; cadence: string };
      }>("status");
      assert.equal(status.agentId, "bob-codex");
      assert.equal(status.daemon.loopRunning, true);
      assert.equal(status.daemon.sessionLive, false);
    } finally {
      client.close();
    }
  });

  it("tracks presence from session lifetime", async () => {
    const client = await DaemonClient.connect(layout.socketPath);
    try {
      assert.equal(daemon.sessionLive, false);
      await client.openSession();
      assert.equal(daemon.sessionLive, true, "an open session marks this agent live");

      const presence = await client.request<{ id: string; status: string }[]>("presence");
      assert.equal(presence.find((p) => p.id === "bob-codex")?.status, "live");
    } finally {
      client.close();
    }

    // Dropping the connection must mark the agent away — an editor that
    // crashes should not leave a peer looking permanently available.
    await waitFor(
      async () => (daemon.sessionLive ? null : true),
      "presence to clear when the session disconnects",
      5_000,
    );
  });

  it("rejects an unknown method rather than guessing", async () => {
    const client = await DaemonClient.connect(layout.socketPath);
    try {
      await assert.rejects(
        () => client.request("definitely-not-a-method" as never),
        /unknown method/,
      );
    } finally {
      client.close();
    }
  });

  it("routes the CLI through the daemon when one is up", async () => {
    const result = await komnet(bobHome, "status", "--json");
    assert.equal(result.code, 0, result.stdout);
    const status = JSON.parse(result.stdout) as { mode: string };
    assert.equal(status.mode, "daemon", "the CLI must prefer the daemon (ADR 0005)");
  });

  it("falls back to direct mode when told to", async () => {
    const result = await komnet(bobHome, "status", "--json", "--direct");
    assert.equal(result.code, 0, result.stdout);
    assert.equal((JSON.parse(result.stdout) as { mode: string }).mode, "direct");
  });
});
