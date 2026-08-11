import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SETUP_TARGETS = ["claude-code", "claude-desktop", "cursor", "codex"] as const;
export type SetupTarget = (typeof SETUP_TARGETS)[number];

export interface SetupChange {
  path: string;
  action: "created" | "updated" | "unchanged";
  what: string;
}

export interface SetupResult {
  target: SetupTarget;
  changes: SetupChange[];
  notes: string[];
}

/**
 * How to invoke this CLI from another tool's config.
 *
 * Prefers the bare name so the config survives reinstalls and version bumps.
 * When komnet is running from a source checkout there is no `komnet` on PATH,
 * so fall back to an absolute invocation — a config pointing at a command that
 * does not exist is worse than a verbose one.
 */
export function resolveInvocation(): { command: string; args: string[] } {
  const entry = process.argv[1];
  if (entry !== undefined && /(?:^|[/\\])bin\.js$/.test(entry)) {
    return { command: process.execPath, args: [entry, "mcp"] };
  }
  return { command: "komnet", args: ["mcp"] };
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // A malformed config must not be silently overwritten — someone hand-edited
    // it and losing that would be worse than refusing.
    throw new Error(`${path} exists but is not valid JSON; fix or remove it first`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Merge a `mcpServers.komnet` entry, preserving every other server and key. */
async function upsertMcpServer(path: string, label: string): Promise<SetupChange> {
  const { command, args } = resolveInvocation();
  const existing = await readJson(path);
  const config = existing ?? {};
  const servers = (config["mcpServers"] ?? {}) as Record<string, unknown>;
  const desired = { command, args };

  if (JSON.stringify(servers["komnet"]) === JSON.stringify(desired)) {
    return { path, action: "unchanged", what: label };
  }
  servers["komnet"] = desired;
  config["mcpServers"] = servers;
  await writeJson(path, config);
  return { path, action: existing === null ? "created" : "updated", what: label };
}

interface HookEntry {
  hooks: { type: string; command: string }[];
}

/**
 * Install Claude Code hooks.
 *
 * These are the highest-value integration in the whole system: they surface
 * pending messages *inside the session the human already opened*, which is what
 * makes staged delivery work without komnet ever spawning an agent (ADR 0006).
 */
async function installClaudeHooks(path: string): Promise<SetupChange> {
  const existing = await readJson(path);
  const config = existing ?? {};
  const hooks = (config["hooks"] ?? {}) as Record<string, unknown>;

  const wanted: Record<string, string> = {
    SessionStart: "komnet inbox --brief",
    Stop: "komnet inbox --brief",
  };

  let changed = false;
  for (const [event, command] of Object.entries(wanted)) {
    const entries = (Array.isArray(hooks[event]) ? hooks[event] : []) as HookEntry[];
    const alreadyThere = entries.some((entry) =>
      (entry.hooks ?? []).some((h) => h.command.includes("komnet inbox")),
    );
    if (alreadyThere) continue;
    entries.push({ hooks: [{ type: "command", command }] });
    hooks[event] = entries;
    changed = true;
  }

  if (!changed) return { path, action: "unchanged", what: "SessionStart/Stop hooks" };
  config["hooks"] = hooks;
  await writeJson(path, config);
  return {
    path,
    action: existing === null ? "created" : "updated",
    what: "SessionStart/Stop hooks",
  };
}

function claudeDesktopConfigPath(): string {
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  }
  if (process.platform === "win32") {
    const appData = process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

/** Codex uses TOML. Append a section rather than rewriting a file we cannot parse. */
async function setupCodex(): Promise<SetupChange> {
  const path = join(homedir(), ".codex", "config.toml");
  const { command, args } = resolveInvocation();
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (/^\s*\[mcp_servers\.komnet\]/m.test(existing)) {
    return { path, action: "unchanged", what: "[mcp_servers.komnet]" };
  }

  const section =
    `\n[mcp_servers.komnet]\n` +
    `command = ${JSON.stringify(command)}\n` +
    `args = [${args.map((a) => JSON.stringify(a)).join(", ")}]\n`;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, existing.length === 0 ? section.trimStart() : existing + section, "utf8");
  return {
    path,
    action: existing.length === 0 ? "created" : "updated",
    what: "[mcp_servers.komnet]",
  };
}

export async function setupTool(target: SetupTarget, cwd = process.cwd()): Promise<SetupResult> {
  const changes: SetupChange[] = [];
  const notes: string[] = [];

  switch (target) {
    case "claude-code": {
      changes.push(await upsertMcpServer(join(cwd, ".mcp.json"), "MCP server entry"));
      changes.push(await installClaudeHooks(join(cwd, ".claude", "settings.json")));
      notes.push(
        "Hooks run inside the session you already opened — no extra agent is started and nothing extra is billed.",
      );
      notes.push("Restart Claude Code (or run /mcp) to pick up the server.");
      break;
    }
    case "claude-desktop": {
      changes.push(await upsertMcpServer(claudeDesktopConfigPath(), "MCP server entry"));
      notes.push("Quit and reopen Claude Desktop to load the server.");
      notes.push(
        "Claude Desktop has no hooks, so ask your agent to check komnet_inbox at the start of a session.",
      );
      break;
    }
    case "cursor": {
      changes.push(await upsertMcpServer(join(cwd, ".cursor", "mcp.json"), "MCP server entry"));
      notes.push("Reload Cursor, then enable the komnet server in Settings → MCP.");
      break;
    }
    case "codex": {
      changes.push(await setupCodex());
      notes.push("Restart Codex to load the server.");
      break;
    }
  }

  notes.push("Nothing here starts an agent: komnet stages messages and a live agent drains them.");
  return { target, changes, notes };
}
