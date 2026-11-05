/**
 * The operator-facing half of the 2026-11-05 incident: `komnet daemon stop`
 * printed "stopped" while the old process kept running and holding a network
 * lock, and `komnet doctor` printed "no problems found" throughout a wedge it
 * had every means to see.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, chmod, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "dist", "bin.js");
const NET = "repair";
const ROOM = "general";

process.env["GIT_AUTHOR_NAME"] = "komnet test";
process.env["GIT_AUTHOR_EMAIL"] = "test@komnet.invalid";
process.env["GIT_COMMITTER_NAME"] = "komnet test";
process.env["GIT_COMMITTER_EMAIL"] = "test@komnet.invalid";
process.env["NO_COLOR"] = "1";

let tmp: string;
let remote: string;

interface Result {
  code: number;
  stdout: string;
}

async function komnet(
  home: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<Result> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
      env: { ...process.env, KOMNET_HOME: home, NO_COLOR: "1", ...env },
    });
    return { code: 0, stdout: `${stdout}${stderr}` };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A fresh agent home on the shared remote, joined to the room. */
async function home(name: string): Promise<string> {
  const path = join(tmp, name);
  const init = await komnet(path, ["init", "--repo", remote, "--network", NET, "--agent", name]);
  assert.equal(init.code, 0, init.stdout);
  const join_ = await komnet(path, ["room", "join", ROOM]);
  assert.equal(join_.code, 0, join_.stdout);
  return path;
}

/** A git wrapper that runs the real git, with one behaviour bolted on. */
async function wrappedGit(name: string, onLsRemote: string): Promise<string> {
  const { stdout } = await exec("/bin/sh", ["-c", "command -v git"]);
  const realGit = stdout.trim();
  const path = join(tmp, `${name}.sh`);
  await writeFile(
    path,
    [
      "#!/bin/sh",
      'case " $* " in',
      `  *" ls-remote "*) ${onLsRemote} ;;`,
      "esac",
      `exec "${realGit}" "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(path, 0o755);
  return path;
}

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "komnet-repair-"));
  remote = join(tmp, "transport.git");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  const owner = join(tmp, "owner");
  assert.equal(
    (await komnet(owner, ["init", "--repo", remote, "--network", NET, "--agent", "owner"])).code,
    0,
  );
  assert.equal((await komnet(owner, ["room", "create", ROOM])).code, 0);
});

after(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("komnet daemon stop", () => {
  it("returns only once the daemon process has actually exited", async () => {
    const agent = await home("stopper");
    const marker = join(tmp, "ls-remote-started");
    const slowGit = await wrappedGit("slow-git", `: > "${marker}"; sleep 4`);

    const child = spawn(process.execPath, [CLI, "daemon", "run"], {
      env: { ...process.env, KOMNET_HOME: agent, KOMNET_GIT: slowGit, MARKER: marker },
      stdio: "ignore",
    });
    const pid = child.pid;
    assert.ok(pid !== undefined);
    try {
      // Wait until the first sync is inside a slow network call.
      const deadline = Date.now() + 20_000;
      while (!(await exists(marker))) {
        if (Date.now() > deadline) throw new Error("the daemon never started syncing");
        await sleep(50);
      }

      const stop = await komnet(agent, ["daemon", "stop"]);
      assert.equal(stop.code, 0, stop.stdout);
      assert.match(stop.stdout, /stopped/);
      assert.equal(
        alive(pid),
        false,
        `'daemon stop' reported success while pid ${String(pid)} was still running`,
      );
    } finally {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  });
});

describe("komnet doctor", () => {
  it("flags a stale git lock and a dirty transport worktree", async () => {
    const agent = await home("doctor-debris");
    const room = join(agent, "networks", NET, "rooms", ROOM);
    const { stdout: adminDir } = await exec("git", ["-C", room, "rev-parse", "--absolute-git-dir"]);
    const lock = join(adminDir.trim(), "index.lock");
    await writeFile(lock, "", "utf8");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(lock, twoHoursAgo, twoHoursAgo);
    await writeFile(join(room, "stray.md"), "left behind by an interrupted write\n", "utf8");

    const doctor = await komnet(agent, ["doctor"]);
    assert.equal(doctor.code, 1, doctor.stdout);
    assert.match(doctor.stdout, /stale git lock/i);
    assert.match(doctor.stdout, /index\.lock/);
    assert.match(doctor.stdout, /uncommitted/i);
    assert.match(doctor.stdout, /stray\.md/);
    assert.doesNotMatch(doctor.stdout, /no problems found/);
    // Report-only: doctor inspects, it does not repair behind your back.
    assert.equal(await exists(lock), true);
  });

  it("flags a network lock a live process has held for a long time", async () => {
    const agent = await home("doctor-held");
    await writeFile(
      join(agent, "networks", NET, "lock"),
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        acquiredAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      }),
      "utf8",
    );
    const doctor = await komnet(agent, ["doctor"]);
    assert.equal(doctor.code, 1, doctor.stdout);
    assert.match(doctor.stdout, new RegExp(`pid ${String(process.pid)}`));
  });

  it("flags a transport whose last sync failed", async () => {
    const agent = await home("doctor-degraded");
    const failingGit = await wrappedGit(
      "failing-git",
      'echo "fatal: simulated outage" >&2; exit 128',
    );
    const sync = await komnet(agent, ["sync", "--direct"], { KOMNET_GIT: failingGit });
    assert.notEqual(sync.code, 0, sync.stdout);

    const doctor = await komnet(agent, ["doctor"]);
    assert.equal(doctor.code, 1, doctor.stdout);
    assert.match(doctor.stdout, /simulated outage/);
  });
});
