import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SETUP_TARGETS = ["claude-code", "claude-desktop", "cursor", "codex"] as const;
export type SetupTarget = (typeof SETUP_TARGETS)[number];

interface SetupChange {
  path: string;
  action: "created" | "updated" | "unchanged";
  what: string;
}

interface SetupResult {
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
function resolveInvocation(): { command: string; args: string[] } {
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
async function upsertMcpServer(
  path: string,
  label: string,
  agentHome: string | undefined,
): Promise<SetupChange> {
  const { command, args } = resolveInvocation();
  const existing = await readJson(path);
  const config = existing ?? {};
  const servers = (config["mcpServers"] ?? {}) as Record<string, unknown>;
  // `KOMNET_HOME` is what gives this tool its own identity. Without it every
  // tool on the machine shares one agent id, and routing — which never returns
  // a message to its author — silently drops everything they send each other.
  const desired =
    agentHome === undefined
      ? { command, args }
      : { command, args, env: { KOMNET_HOME: agentHome } };

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
 * Install the Claude Code `SessionStart` hook, and remove komnet's old `Stop` hook.
 *
 * One hook, once per session. It surfaces whatever accumulated while no agent was
 * running *inside the session the human already opened*, which is what makes staged
 * delivery work without komnet ever spawning an agent (ADR 0006).
 *
 * There is deliberately no `Stop` hook. An earlier version installed one, so komnet
 * ran `inbox --brief` after every single turn — a subprocess per request to report a
 * count that rarely changed. Once a session is running, deciding when to look at the
 * inbox belongs to the agent, which has the context to know whether a teammate's
 * message is relevant to what it is doing; the `komnet:inbox` skill covers it. This
 * function prunes the old entry so re-running setup fixes an existing install rather
 * than leaving the per-turn hook behind.
 *
 * Pruning only ever removes an entry komnet itself wrote — matched on its own
 * `komnet inbox` command — and leaves every other `Stop` hook untouched.
 */
async function installClaudeHooks(path: string): Promise<SetupChange> {
  const existing = await readJson(path);
  const config = existing ?? {};
  const hooks = (config["hooks"] ?? {}) as Record<string, unknown>;

  const isKomnetHook = (entry: HookEntry): boolean =>
    (entry.hooks ?? []).some((h) => h.command.includes("komnet inbox"));

  let changed = false;

  const sessionStart = (
    Array.isArray(hooks["SessionStart"]) ? hooks["SessionStart"] : []
  ) as HookEntry[];
  if (!sessionStart.some(isKomnetHook)) {
    sessionStart.push({ hooks: [{ type: "command", command: "komnet inbox --brief" }] });
    hooks["SessionStart"] = sessionStart;
    changed = true;
  }

  const stop = (Array.isArray(hooks["Stop"]) ? hooks["Stop"] : []) as HookEntry[];
  const keep = stop.filter((entry) => !isKomnetHook(entry));
  if (keep.length !== stop.length) {
    if (keep.length === 0) delete hooks["Stop"];
    else hooks["Stop"] = keep;
    changed = true;
  }

  if (!changed) return { path, action: "unchanged", what: "SessionStart hook" };
  config["hooks"] = hooks;
  await writeJson(path, config);
  return {
    path,
    action: existing === null ? "created" : "updated",
    what: "SessionStart hook",
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

interface TomlSection {
  bodyStart: number;
  end: number;
}

function tomlSection(source: string, name: string): TomlSection | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^[ \\t]*\\[${escaped}\\][ \\t]*(?:#.*)?$`, "m").exec(source);
  if (header === null) return null;

  const newline = source.indexOf("\n", header.index + header[0].length);
  const bodyStart = newline === -1 ? source.length : newline + 1;
  const next = /^[ \t]*\[[^\]\r\n]+\][ \t]*(?:#.*)?$/m.exec(source.slice(bodyStart));
  return { bodyStart, end: next === null ? source.length : bodyStart + next.index };
}

function insertAtSectionStart(source: string, section: TomlSection, line: string): string {
  const needsLeadingNewline = section.bodyStart === source.length && !source.endsWith("\n");
  return (
    source.slice(0, section.bodyStart) +
    (needsLeadingNewline ? "\n" : "") +
    `${line}\n` +
    source.slice(section.bodyStart)
  );
}

/**
 * Pin an existing Codex MCP entry without rewriting unrelated TOML.
 *
 * We own only this environment value. Codex accepts either an inline `env`
 * table or a `[mcp_servers.komnet.env]` table, so support both and preserve
 * every other key a person may have added to the server entry.
 */
function pinCodexHome(source: string, agentHome: string): string {
  const server = tomlSection(source, "mcp_servers.komnet");
  if (server === null) return source;

  const body = source.slice(server.bodyStart, server.end);
  const inline = /^([ \t]*env[ \t]*=[ \t]*\{)([^\r\n{}]*)(\}[ \t]*(?:#.*)?)$/m.exec(body);
  if (inline !== null) {
    const inner = inline[2] ?? "";
    const home = /(^[ \t]*|,[ \t]*)(KOMNET_HOME[ \t]*=[ \t]*)(?:"(?:\\.|[^"\\])*"|'[^']*')/.exec(
      inner,
    );
    let updated: string;
    if (home !== null) {
      updated =
        inner.slice(0, home.index) +
        (home[1] ?? "") +
        (home[2] ?? "KOMNET_HOME = ") +
        JSON.stringify(agentHome) +
        inner.slice(home.index + home[0].length);
    } else {
      if (/\bKOMNET_HOME\b[ \t]*=/.test(inner)) {
        throw new Error(
          "[mcp_servers.komnet].env has an unsupported KOMNET_HOME value; make it a quoted string and run setup again",
        );
      }
      const trimmed = inner.trimEnd();
      updated = `${trimmed}${trimmed.trim().length === 0 ? " " : ", "}KOMNET_HOME = ${JSON.stringify(agentHome)} `;
    }
    const replacement = `${inline[1] ?? "env = {"}${updated}${inline[3] ?? "}"}`;
    const start = server.bodyStart + inline.index;
    return source.slice(0, start) + replacement + source.slice(start + inline[0].length);
  }

  const env = tomlSection(source, "mcp_servers.komnet.env");
  if (env !== null) {
    const envBody = source.slice(env.bodyStart, env.end);
    const home =
      /^([ \t]*)KOMNET_HOME[ \t]*=[ \t]*(?:"(?:\\.|[^"\\])*"|'[^']*')([ \t]*(?:#.*)?)$/m.exec(
        envBody,
      );
    if (home !== null) {
      const replacement = `${home[1] ?? ""}KOMNET_HOME = ${JSON.stringify(agentHome)}${home[2] ?? ""}`;
      const start = env.bodyStart + home.index;
      return source.slice(0, start) + replacement + source.slice(start + home[0].length);
    }
    if (/^[ \t]*KOMNET_HOME[ \t]*=/m.test(envBody)) {
      throw new Error(
        "[mcp_servers.komnet.env].KOMNET_HOME has an unsupported value; make it a quoted string and run setup again",
      );
    }
    return insertAtSectionStart(source, env, `KOMNET_HOME = ${JSON.stringify(agentHome)}`);
  }

  return insertAtSectionStart(
    source,
    server,
    `env = { KOMNET_HOME = ${JSON.stringify(agentHome)} }`,
  );
}

/**
 * Codex uses TOML. Append our section when absent; when it already exists,
 * update only the identity pin we own instead of pretending setup succeeded.
 */
async function setupCodex(agentHome: string | undefined): Promise<SetupChange> {
  const path = join(homedir(), ".codex", "config.toml");
  const { command, args } = resolveInvocation();
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (tomlSection(existing, "mcp_servers.komnet") !== null) {
    if (agentHome === undefined) {
      return { path, action: "unchanged", what: "[mcp_servers.komnet]" };
    }
    const updated = pinCodexHome(existing, agentHome);
    if (updated === existing) {
      return { path, action: "unchanged", what: "[mcp_servers.komnet]" };
    }
    await writeFile(path, updated, "utf8");
    return { path, action: "updated", what: "[mcp_servers.komnet] identity" };
  }

  const section =
    `\n[mcp_servers.komnet]\n` +
    `command = ${JSON.stringify(command)}\n` +
    `args = [${args.map((a) => JSON.stringify(a)).join(", ")}]\n` +
    (agentHome === undefined ? "" : `env = { KOMNET_HOME = ${JSON.stringify(agentHome)} }\n`);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, existing.length === 0 ? section.trimStart() : existing + section, "utf8");
  return {
    path,
    action: existing.length === 0 ? "created" : "updated",
    what: "[mcp_servers.komnet]",
  };
}

interface SetupOptions {
  cwd?: string;
  /**
   * KOMNET_HOME to pin this tool to, giving it its own agent identity.
   *
   * Omitted, the tool shares the machine-wide identity — which is correct for a
   * single-agent machine and wrong the moment a second tool joins.
   */
  agentHome?: string;
}

export async function setupTool(
  target: SetupTarget,
  options: SetupOptions = {},
): Promise<SetupResult> {
  const cwd = options.cwd ?? process.cwd();
  const agentHome = options.agentHome;
  const changes: SetupChange[] = [];
  const notes: string[] = [];

  switch (target) {
    case "claude-code": {
      changes.push(await upsertMcpServer(join(cwd, ".mcp.json"), "MCP server entry", agentHome));
      changes.push(await installClaudeHooks(join(cwd, ".claude", "settings.json")));
      notes.push(
        "One hook, at session start, inside the session you already opened — no extra agent is started and nothing extra is billed. During a session your agent decides when to check.",
      );
      notes.push("Restart Claude Code (or run /mcp) to pick up the server.");
      break;
    }
    case "claude-desktop": {
      changes.push(await upsertMcpServer(claudeDesktopConfigPath(), "MCP server entry", agentHome));
      notes.push("Quit and reopen Claude Desktop to load the server.");
      notes.push(
        "Claude Desktop has no hooks, so ask your agent to check komnet_inbox at the start of a session.",
      );
      break;
    }
    case "cursor": {
      changes.push(
        await upsertMcpServer(join(cwd, ".cursor", "mcp.json"), "MCP server entry", agentHome),
      );
      notes.push("Reload Cursor, then enable the komnet server in Settings → MCP.");
      break;
    }
    case "codex": {
      changes.push(await setupCodex(agentHome));
      notes.push("Restart Codex to load the server.");
      break;
    }
  }

  if (agentHome !== undefined) {
    notes.push(`This tool now runs as its own agent, with KOMNET_HOME=${agentHome}.`);
  }
  notes.push("Nothing here starts an agent: komnet stages messages and a live agent drains them.");
  return { target, changes, notes };
}
