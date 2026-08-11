import { execFile } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type SupervisorKind = "launchd" | "systemd" | "unsupported";

export const SERVICE_LABEL = "dev.komnet.daemon";

export function detectSupervisor(): SupervisorKind {
  if (process.platform === "darwin") return "launchd";
  if (process.platform === "linux") return "systemd";
  return "unsupported";
}

export function unitPath(kind: SupervisorKind): string {
  if (kind === "launchd")
    return join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  if (kind === "systemd") return join(homedir(), ".config", "systemd", "user", "komnet.service");
  throw new Error(`no supervisor integration for ${process.platform}`);
}

/**
 * Note the absence of any privileged install path.
 *
 * The daemon runs as the user, unprivileged, under the platform's own user-level
 * supervisor — never as a system service. It needs the user's git credentials
 * and home directory, and nothing more; requiring root to run a chat client
 * would be a smell.
 */
export function renderUnit(
  kind: SupervisorKind,
  execPath: string,
  args: readonly string[],
): string {
  const logDir = join(homedir(), ".komnet", "logs");

  if (kind === "launchd") {
    const programArgs = [execPath, ...args]
      .map((a) => `    <string>${escapeXml(a)}</string>`)
      .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(join(logDir, "daemon.out.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(logDir, "daemon.err.log"))}</string>
</dict>
</plist>
`;
  }

  if (kind === "systemd") {
    return `[Unit]
Description=kom-net daemon
Documentation=https://github.com/Komdosh/kom-net
After=network-online.target

[Service]
Type=simple
ExecStart=${[execPath, ...args].map(shellQuote).join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  }

  throw new Error(`no supervisor integration for ${process.platform}`);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_\-./]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

export interface InstallResult {
  kind: SupervisorKind;
  path: string;
  started: boolean;
  hint: string;
}

export async function installService(
  execPath: string,
  args: readonly string[],
): Promise<InstallResult> {
  const kind = detectSupervisor();
  if (kind === "unsupported") {
    throw new Error(
      `automatic startup is not supported on ${process.platform}. Run 'komnetd' yourself, or use a scheduled task.`,
    );
  }

  const path = unitPath(kind);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderUnit(kind, execPath, args), "utf8");

  let started = false;
  let hint = "";
  try {
    if (kind === "launchd") {
      // `bootout` first so a re-install replaces a running agent rather than
      // failing with "service already loaded".
      await exec("launchctl", [
        "bootout",
        `gui/${String(process.getuid?.() ?? 0)}/${SERVICE_LABEL}`,
      ]).catch(() => undefined);
      await exec("launchctl", ["bootstrap", `gui/${String(process.getuid?.() ?? 0)}`, path]);
      started = true;
      hint = `launchctl bootout gui/$(id -u)/${SERVICE_LABEL}   # to stop`;
    } else {
      await exec("systemctl", ["--user", "daemon-reload"]);
      await exec("systemctl", ["--user", "enable", "--now", "komnet.service"]);
      started = true;
      hint = "systemctl --user status komnet.service";
    }
  } catch (error) {
    hint = `unit written to ${path}, but starting it failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }

  return { kind, path, started, hint };
}

export async function uninstallService(): Promise<{ kind: SupervisorKind; removed: boolean }> {
  const kind = detectSupervisor();
  if (kind === "unsupported") return { kind, removed: false };
  const path = unitPath(kind);

  try {
    if (kind === "launchd") {
      await exec("launchctl", [
        "bootout",
        `gui/${String(process.getuid?.() ?? 0)}/${SERVICE_LABEL}`,
      ]);
    } else {
      await exec("systemctl", ["--user", "disable", "--now", "komnet.service"]);
    }
  } catch {
    // Already stopped, or never started — removing the unit still matters.
  }

  let removed = false;
  try {
    await unlink(path);
    removed = true;
  } catch {
    removed = false;
  }
  if (kind === "systemd")
    await exec("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
  return { kind, removed };
}

export async function isServiceInstalled(): Promise<boolean> {
  const kind = detectSupervisor();
  if (kind === "unsupported") return false;
  try {
    await readFile(unitPath(kind), "utf8");
    return true;
  } catch {
    return false;
  }
}
