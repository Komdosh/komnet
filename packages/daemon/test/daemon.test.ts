import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { Layout } from "@komnet/core";

import { Daemon } from "../src/daemon.ts";
import { DaemonClient } from "../src/client.ts";
import {
  DAEMON_ONLY_METHODS,
  LineFramer,
  encode,
  isDaemonOnlyMethod,
  isMethod,
} from "../src/protocol.ts";
import { createNotifier, sanitize, shouldNotify } from "../src/notify.ts";
import { renderUnit } from "../src/supervisor.ts";

const exec = promisify(execFile);

process.env["GIT_AUTHOR_NAME"] = "komnet test";
process.env["GIT_AUTHOR_EMAIL"] = "test@komnet.invalid";
process.env["GIT_COMMITTER_NAME"] = "komnet test";
process.env["GIT_COMMITTER_EMAIL"] = "test@komnet.invalid";
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

/** Bob's agent card as the rest of the network sees it. */
async function publishedCard(agent = "bob-codex", repository = remote): Promise<string> {
  const { stdout } = await exec(
    "git",
    ["--git-dir", repository, "show", `main:agents/${agent}.yaml`],
    { encoding: "utf8" },
  );
  return stdout;
}

/** How many commits the record branch carries — the cost presence writes pay. */
async function mainCommitCount(): Promise<number> {
  const { stdout } = await exec("git", ["--git-dir", remote, "rev-list", "--count", "main"], {
    encoding: "utf8",
  });
  return Number(stdout.trim());
}

/** The same count, narrowed to one agent's card, so profile writes do not count. */
async function cardCommitCount(agent = "bob-codex", repository = remote): Promise<number> {
  const { stdout } = await exec(
    "git",
    ["--git-dir", repository, "rev-list", "--count", "main", "--", `agents/${agent}.yaml`],
    { encoding: "utf8" },
  );
  return Number(stdout.trim());
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
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

  it("names the methods direct mode is excused from, and only those", () => {
    // The exhaustiveness check in DirectBackend is a compile-time guarantee and
    // cannot be asserted at runtime; this pins the list it leans on. Every entry
    // must be a real method, and the exclusions must stay deliberate — quietly
    // adding one here is exactly how an unimplemented method would go back to
    // looking like an intentional daemon-only decision.
    for (const method of DAEMON_ONLY_METHODS) {
      assert.ok(isMethod(method), `${method} is excluded but is not a method`);
      assert.ok(isDaemonOnlyMethod(method));
    }
    assert.deepEqual([...DAEMON_ONLY_METHODS].sort(), [
      "networks",
      "ping",
      "sessionClose",
      "sessionOpen",
      "shutdown",
    ]);
    assert.ok(!isDaemonOnlyMethod("send"));
    assert.ok(!isDaemonOnlyMethod("inbox"));
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
    daemon = new Daemon({
      layout,
      notifier: "none",
      log: () => undefined,
      // Arrival is not debounced here on purpose: a one-shot command must be
      // silent because it declares no session, not because it outran a timer.
      presenceLiveGraceMs: 0,
    });
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

  it("stamps a session's arrival, and lets its departure be derived", async () => {
    const before = await cardCommitCount();
    const client = await DaemonClient.connect(layout.socketPath);
    try {
      assert.equal(daemon.sessionLive, false);
      await client.openSession({ client: "mcp", platform: "darwin", architecture: "arm64" });
      assert.equal(daemon.sessionLive, true, "an open session marks this agent live");

      const presence = await client.request<{ id: string; status: string }[]>("presence");
      assert.equal(presence.find((p) => p.id === "bob-codex")?.status, "live");
      // An arrival IS published — it is the one thing silence cannot express.
      await waitFor(
        async () => ((await publishedCard()).includes("status: live") ? true : null),
        "the arrival to reach the remote",
        10_000,
      );
      const profile = await client.request<{
        environment: { client: string; platform: string; architecture: string };
      }>("profileGet");
      assert.deepEqual(profile.environment, {
        client: "mcp",
        platform: "darwin",
        architecture: "arm64",
      });
    } finally {
      client.close();
    }

    await waitFor(
      async () => (daemon.sessionLive ? null : true),
      "the session to be dropped",
      5_000,
    );
    // The departure costs nothing. A crashed editor cannot publish `away`
    // either, so the network learns it the same way in both cases: the stamp
    // stops moving and every reader ages it out.
    await sleep(1_000);
    assert.equal(
      await cardCommitCount(),
      before + 1,
      "a whole session must cost exactly one card commit — the arrival",
    );
    assert.match(await publishedCard(), /status: live/, "no away transition is written");
  });

  it("scopes a desktop session and its presence to the selected network", async () => {
    const otherRemote = join(tmp, "other-transport.git");
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", otherRemote]);
    assert.equal(
      (await komnet(bobHome, "init", "--repo", otherRemote, "--network", "other-project")).code,
      0,
    );

    const acmeBefore = await cardCommitCount();
    const otherBefore = await cardCommitCount("bob-codex", otherRemote);
    const client = await DaemonClient.connect(layout.socketPath);
    try {
      await client.openSession(
        { client: "mcp", platform: "darwin", architecture: "arm64" },
        "other-project",
      );
      const acme = await client.request<{ daemon: { sessionLive: boolean; sessions: number } }>(
        "status",
        {},
        "acme",
      );
      const other = await client.request<{ daemon: { sessionLive: boolean; sessions: number } }>(
        "status",
        {},
        "other-project",
      );
      assert.equal(acme.daemon.sessionLive, false);
      assert.equal(acme.daemon.sessions, 0);
      assert.equal(other.daemon.sessionLive, true);
      assert.equal(other.daemon.sessions, 1);

      await waitFor(
        async () =>
          (await publishedCard("bob-codex", otherRemote)).includes("status: live") ? true : null,
        "project-scoped presence",
        10_000,
      );
      assert.equal(
        await cardCommitCount(),
        acmeBefore,
        "a session in another desktop project must not announce presence here",
      );
      assert.equal(await cardCommitCount("bob-codex", otherRemote), otherBefore + 1);
    } finally {
      client.close();
    }
    await waitFor(async () => (daemon.sessionLive ? null : true), "the scoped session to close");
  });

  it("does not publish presence for a one-shot command", async () => {
    // The chatter this prevents: `openBackend` used to declare every CLI
    // process an agent session, so a command that lived for a second stamped
    // the card `live` and then wrote `away` once the grace expired — two
    // commits and two pushes on `main`, per command, per network, for a session
    // that was never attached.
    const before = await mainCommitCount();
    assert.equal((await komnet(bobHome, "status")).code, 0);
    assert.equal((await komnet(bobHome, "inbox")).code, 0);
    // Well past the arrival grace: if a transition were queued, it lands by now.
    await sleep(1_500);

    assert.equal(
      await mainCommitCount(),
      before,
      "a one-shot command must leave no commit on the record branch",
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

  it("answers about the network the caller asked for, not the daemon's default", async () => {
    // The reported failure, and the worst kind: `--network` was resolved in
    // direct mode and silently dropped in daemon mode, because the client never
    // put it on the request. So a watcher armed on one conversation was
    // answered about the daemon's default network — and an inbox that is empty
    // because you are reading somewhere else looks exactly like a quiet room.
    const second = join(tmp, "second.git");
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", second]);
    assert.equal(
      (await komnet(bobHome, "init", "--repo", second, "--network", "sideband")).code,
      0,
    );

    const asked = JSON.parse(
      (await komnet(bobHome, "status", "--json", "--network", "sideband")).stdout,
    ) as { networkId: string; mode: string };
    assert.equal(asked.mode, "daemon", "this must exercise the daemon path, not direct mode");
    assert.equal(asked.networkId, "sideband", "the answer must be about the network asked for");

    // And an unknown one fails loudly rather than answering about another.
    const wrong = await komnet(bobHome, "status", "--network", "not-a-network");
    assert.equal(wrong.code, 1);
    assert.match(wrong.stdout, /unknown network/);
  });
});

describe("stalled work", () => {
  let home: string;
  let daemon: Daemon;
  let layout: Layout;
  let noticePath: string;

  before(async () => {
    home = join(tmp, "dana");
    assert.equal(
      (await komnet(home, "init", "--repo", remote, "--network", "acme", "--agent", "dana-claude"))
        .code,
      0,
    );
    assert.equal((await komnet(home, "room", "join", "architecture")).code, 0);
    layout = new Layout(home);
    noticePath = join(layout.inboxDir, "NOTICE.md");
  });

  after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  it("reports a task that has stopped moving, and reports it only once", async () => {
    const created = await komnet(
      home,
      "task",
      "create",
      "architecture",
      "Wire the ledger migration through checkout.",
      "--title",
      "Ledger migration",
      "--json",
    );
    assert.equal(created.code, 0, created.stdout);
    const taskId = (JSON.parse(created.stdout) as { task: { id: string } }).task.id;
    assert.equal((await komnet(home, "task", "claim", "architecture", taskId, "Mine.")).code, 0);
    assert.equal(
      (await komnet(home, "task", "update", "architecture", taskId, "started", "Underway.")).code,
      0,
    );
    // `blocked` is health that does not depend on elapsed time, so this asserts
    // the escalation itself rather than waiting out a staleness deadline.
    assert.equal(
      (
        await komnet(
          home,
          "task",
          "update",
          "architecture",
          taskId,
          "blocked",
          "Waiting on the payments schema.",
        )
      ).code,
      0,
    );

    // Interval 0 so "reported once" is proven by the reported-set, never by the
    // rate limiter — otherwise the second assertion would pass vacuously.
    daemon = new Daemon({
      layout,
      notifier: "file",
      stallScanIntervalMs: 0,
      autoSync: false,
      log: () => undefined,
    });
    await daemon.start();

    const client = await DaemonClient.connect(layout.socketPath);
    try {
      await client.request("sync");
      const first = await readFile(noticePath, "utf8");
      const matches = first.match(/blocked · Ledger migration/g) ?? [];
      assert.equal(matches.length, 1, `expected one report, got:\n${first}`);

      // Nothing changed, so nothing more should be said.
      await client.request("sync");
      await client.request("sync");
      const again = await readFile(noticePath, "utf8");
      assert.equal(
        (again.match(/blocked · Ledger migration/g) ?? []).length,
        1,
        `a task that has already been reported must stay quiet:\n${again}`,
      );

      // A different health is a new fact, so it is reported again.
      assert.equal(
        (
          await komnet(
            home,
            "task",
            "update",
            "architecture",
            taskId,
            "stuck",
            "No approach left that I own.",
          )
        ).code,
        0,
      );
      await client.request("sync");
      const escalated = await readFile(noticePath, "utf8");
      assert.match(escalated, /stuck · Ledger migration/);
    } finally {
      client.close();
    }
  });
});
