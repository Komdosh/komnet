import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { Layout } from "@komnet/core";
import {
  DaemonClient,
  detectSupervisor,
  installService,
  isServiceInstalled,
  uninstallService,
  unitPath,
} from "@komnet/daemon";

/**
 * Resolve how to launch the daemon from whatever this CLI actually is.
 *
 * Three shapes, in order of confidence:
 *
 *  1. **Workspace checkout** — `node …/daemon/dist/bin.js`, found next to the
 *     CLI's own entry point.
 *  2. **Packaged binary** — the release artifact is ONE self-contained
 *     executable that already contains the daemon, so it launches itself with
 *     `daemon run`, the same command the supervisor unit executes.
 *  3. **`komnetd` on PATH** — only meaningful for a hand-built split install.
 *
 * Case 2 previously fell through to case 3, which could never work: `install.sh`
 * installs a single binary and never a `komnetd`, so every release install hit
 * `spawn komnetd ENOENT`. That broke `daemon start` outright, and — because
 * `daemonInstall` resolves through here too — wrote a supervisor unit pointing
 * at a binary that does not exist, failing again at every login.
 */
export interface DaemonEntry {
  command: string;
  args: string[];
}

/**
 * The decision, as a pure function of what this process is.
 *
 * Split out from the filesystem probe so the packaged-binary case can be tested
 * without being a packaged binary — the case that shipped broken precisely
 * because it is the one a workspace test run never exercises.
 */
export function daemonEntryFor(
  execPath: string,
  argv1: string | undefined,
  sibling: string | null,
): DaemonEntry {
  if (sibling !== null && argv1 !== undefined && /(?:^|[/\\])bin\.js$/.test(argv1)) {
    return { command: execPath, args: [sibling] };
  }
  // Running as anything other than plain `node` means this executable IS the
  // packaged komnet, and it can host the daemon itself.
  //
  // The final segment is taken on both separators rather than through
  // `path.basename`, which only splits `\` when the process is actually on
  // Windows — so the check would otherwise mean something different depending
  // on where it ran, and could not be tested honestly from one platform.
  const leaf = execPath.split(/[/\\]/).pop() ?? execPath;
  if (!/^node(\.exe)?$/i.test(leaf)) {
    return { command: execPath, args: ["daemon", "run"] };
  }
  return { command: "komnetd", args: [] };
}

export async function resolveDaemonEntry(): Promise<DaemonEntry> {
  const entry = process.argv[1];
  let sibling: string | null = null;
  if (entry !== undefined && /(?:^|[/\\])bin\.js$/.test(entry)) {
    const candidate = join(dirname(entry), "..", "..", "daemon", "dist", "bin.js");
    try {
      await access(candidate);
      sibling = candidate;
    } catch {
      // Not a workspace layout — fall through.
    }
  }
  return daemonEntryFor(process.execPath, entry, sibling);
}

/**
 * Report whether the resolved entry can actually be executed.
 *
 * `doctor` needs this: telling someone to run `komnet daemon start` when the
 * command it would spawn does not exist is worse than silence, because it reads
 * as a working instruction.
 */
export async function daemonEntryProblem(): Promise<string | null> {
  const { command, args } = await resolveDaemonEntry();

  // A bare command name is only resolvable through PATH.
  if (command === "komnetd") {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    try {
      await promisify(execFile)("command", ["-v", "komnetd"], { shell: "/bin/sh" });
      return null;
    } catch {
      return "'komnetd' is not on PATH, and this build cannot host the daemon itself";
    }
  }

  // Which of `command`/`args` names a file depends on the shape resolved above.
  // In the workspace case the executable is `node` and the daemon is the script
  // in args[0]; in the packaged case the executable IS the daemon and args are
  // subcommands, so `args[0]` is the word "daemon" and not a path at all.
  const script = args[0];
  const target = script !== undefined && script.endsWith(".js") ? script : command;
  try {
    await access(target);
    return null;
  } catch {
    return `the daemon entry point ${target} is missing`;
  }
}

export interface DaemonStatus {
  running: boolean;
  socket: string;
  serviceInstalled: boolean;
  supervisor: string;
  unit: string | null;
  detail?: unknown;
}

export async function daemonStatus(layout: Layout): Promise<DaemonStatus> {
  const supervisor = detectSupervisor();
  const running = await DaemonClient.isAlive(layout.socketPath);
  const serviceInstalled = await isServiceInstalled();

  const status: DaemonStatus = {
    running,
    socket: layout.socketPath,
    serviceInstalled,
    supervisor,
    unit: supervisor === "unsupported" ? null : unitPath(supervisor),
  };

  if (running) {
    const client = await DaemonClient.tryConnect(layout.socketPath);
    if (client !== null) {
      try {
        status.detail = await client.request("ping");
      } finally {
        client.close();
      }
    }
  }
  return status;
}

/**
 * Start the daemon detached.
 *
 * Detached and with stdio ignored on purpose: the daemon must outlive the shell
 * that started it, and a pipe nobody drains would eventually block it.
 */
export async function daemonStart(layout: Layout): Promise<{ started: boolean; message: string }> {
  if (await DaemonClient.isAlive(layout.socketPath)) {
    return { started: false, message: "already running" };
  }

  const { command, args } = await resolveDaemonEntry();
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });

  // A spawn failure arrives as an 'error' event, not a throw. Unhandled on a
  // ChildProcess it becomes an unhandled exception, so a missing daemon binary
  // surfaced as a Node stack trace rather than something a person could act on.
  const spawnState: { error: NodeJS.ErrnoException | null } = { error: null };
  child.on("error", (error: NodeJS.ErrnoException) => {
    spawnState.error = error;
  });
  child.unref();

  // Poll rather than assume: a daemon that dies on startup (bad config, socket
  // in use) should be reported here, not discovered on the next command.
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(100);
    if (await DaemonClient.isAlive(layout.socketPath)) {
      return { started: true, message: `running (pid ${String(child.pid ?? 0)})` };
    }
    const failure = spawnState.error;
    if (failure !== null) {
      return {
        started: false,
        message:
          failure.code === "ENOENT"
            ? `cannot launch the daemon: '${command}' was not found. ` +
              `This build cannot host the daemon itself — reinstall komnet, or run 'komnet daemon run' in a terminal.`
            : `cannot launch the daemon: ${failure.message}`,
      };
    }
  }
  return {
    started: false,
    message: `daemon did not come up within 4s — check ${join(layout.logsDir, "daemon.log")}`,
  };
}

export async function daemonStop(layout: Layout): Promise<{ stopped: boolean; message: string }> {
  const client = await DaemonClient.tryConnect(layout.socketPath);
  if (client === null) return { stopped: false, message: "not running" };
  try {
    await client.request("shutdown");
  } catch {
    // The daemon may close the socket before answering; that is a clean stop.
  } finally {
    client.close();
  }

  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(100);
    if (!(await DaemonClient.isAlive(layout.socketPath))) {
      return { stopped: true, message: "stopped" };
    }
  }
  return { stopped: false, message: "daemon did not stop within 3s" };
}

export async function daemonInstall(): Promise<string[]> {
  const { command, args } = await resolveDaemonEntry();
  const result = await installService(command, args);
  return [
    `${result.started ? "installed and started" : "installed"} via ${result.kind}`,
    `unit: ${result.path}`,
    ...(result.hint === "" ? [] : [result.hint]),
  ];
}

export async function daemonUninstall(): Promise<string[]> {
  const result = await uninstallService();
  return [result.removed ? `removed the ${result.kind} unit` : `no ${result.kind} unit to remove`];
}
