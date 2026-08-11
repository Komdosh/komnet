import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { Layout } from "@kom-net/core";
import {
  DaemonClient,
  detectSupervisor,
  installService,
  isServiceInstalled,
  uninstallService,
  unitPath,
} from "@kom-net/daemon";

/** Locate `komnetd` next to this CLI, falling back to PATH. */
export async function resolveDaemonEntry(): Promise<{ command: string; args: string[] }> {
  const entry = process.argv[1];
  if (entry !== undefined && /(?:^|[/\\])bin\.js$/.test(entry)) {
    const sibling = join(dirname(entry), "..", "..", "daemon", "dist", "bin.js");
    try {
      await access(sibling);
      return { command: process.execPath, args: [sibling] };
    } catch {
      // Not a workspace layout — fall through to PATH.
    }
  }
  return { command: "komnetd", args: [] };
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
  child.unref();

  // Poll rather than assume: a daemon that dies on startup (bad config, socket
  // in use) should be reported here, not discovered on the next command.
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(100);
    if (await DaemonClient.isAlive(layout.socketPath)) {
      return { started: true, message: `running (pid ${String(child.pid ?? 0)})` };
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
