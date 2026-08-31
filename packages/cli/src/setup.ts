import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SETUP_TARGETS = ["claude-code", "claude-desktop", "cursor", "codex"] as const;
export type SetupTarget = (typeof SETUP_TARGETS)[number];

interface SetupChange {
  path: string;
  action: "created" | "updated" | "removed" | "unchanged";
  what: string;
}

interface SetupResult {
  target: SetupTarget;
  changes: SetupChange[];
  notes: string[];
  /** Conditions that will silently break delivery. See `toolsSharingIdentity`. */
  warnings: string[];
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

function isKomnetInboxCommand(hook: unknown): boolean {
  return (
    typeof hook === "object" &&
    hook !== null &&
    typeof (hook as { command?: unknown }).command === "string" &&
    (hook as { command: string }).command.includes("komnet inbox")
  );
}

function isKomnetHook(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const hooks = (entry as { hooks?: unknown }).hooks;
  return Array.isArray(hooks) && hooks.some(isKomnetInboxCommand);
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

async function removeMcpServer(path: string, label: string): Promise<SetupChange> {
  const config = await readJson(path);
  if (config === null) return { path, action: "unchanged", what: label };

  const value = config["mcpServers"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { path, action: "unchanged", what: label };
  }

  const servers = value as Record<string, unknown>;
  if (!Object.hasOwn(servers, "komnet")) {
    return { path, action: "unchanged", what: label };
  }

  delete servers["komnet"];
  if (Object.keys(servers).length === 0) delete config["mcpServers"];
  await writeJson(path, config);
  return { path, action: "removed", what: label };
}

async function removeClaudeHooks(path: string): Promise<SetupChange> {
  const config = await readJson(path);
  if (config === null) return { path, action: "unchanged", what: "inbox hooks" };

  const value = config["hooks"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { path, action: "unchanged", what: "inbox hooks" };
  }

  const hooks = value as Record<string, unknown>;
  let changed = false;
  for (const event of ["SessionStart", "Stop"]) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const keep: unknown[] = [];
    let eventChanged = false;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) {
        keep.push(entry);
        continue;
      }
      const entryHooks = (entry as { hooks?: unknown }).hooks;
      if (!Array.isArray(entryHooks)) {
        keep.push(entry);
        continue;
      }
      const keptHooks = entryHooks.filter((hook) => !isKomnetInboxCommand(hook));
      if (keptHooks.length === entryHooks.length) {
        keep.push(entry);
        continue;
      }
      eventChanged = true;
      if (keptHooks.length > 0) keep.push({ ...entry, hooks: keptHooks });
    }
    if (!eventChanged) continue;
    if (keep.length === 0) delete hooks[event];
    else hooks[event] = keep;
    changed = true;
  }

  if (!changed) return { path, action: "unchanged", what: "inbox hooks" };
  if (Object.keys(hooks).length === 0) delete config["hooks"];
  await writeJson(path, config);
  return { path, action: "removed", what: "inbox hooks" };
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
  name: string;
  start: number;
  bodyStart: number;
  end: number;
}

function tomlSections(source: string): TomlSection[] {
  const headers: Omit<TomlSection, "end">[] = [];
  const pattern = /^[ \t]*\[([^\]\r\n]+)\][ \t]*(?:#.*)?$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const newline = source.indexOf("\n", match.index + match[0].length);
    headers.push({
      name: match[1] ?? "",
      start: match.index,
      bodyStart: newline === -1 ? source.length : newline + 1,
    });
  }
  return headers.map((header, index) => ({
    ...header,
    end: headers[index + 1]?.start ?? source.length,
  }));
}

function tomlSection(source: string, name: string): TomlSection | null {
  return tomlSections(source).find((section) => section.name === name) ?? null;
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

async function removeCodex(): Promise<SetupChange> {
  const path = join(homedir(), ".codex", "config.toml");
  let existing: string;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, action: "unchanged", what: "[mcp_servers.komnet]" };
    }
    throw error;
  }

  const sections = tomlSections(existing).filter(
    (section) =>
      section.name === "mcp_servers.komnet" || section.name.startsWith("mcp_servers.komnet."),
  );
  if (sections.length === 0) {
    return { path, action: "unchanged", what: "[mcp_servers.komnet]" };
  }

  let updated = existing;
  for (const section of sections.toSorted((a, b) => b.start - a.start)) {
    updated = updated.slice(0, section.start) + updated.slice(section.end);
  }
  await writeFile(path, updated, "utf8");
  return { path, action: "removed", what: "[mcp_servers.komnet]" };
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

/** Where each tool keeps the komnet MCP entry, so setup can see the others. */
function configPathOf(target: SetupTarget, cwd: string): string {
  switch (target) {
    case "claude-code":
      return join(cwd, ".mcp.json");
    case "claude-desktop":
      return claudeDesktopConfigPath();
    case "cursor":
      return join(cwd, ".cursor", "mcp.json");
    case "codex":
      return join(homedir(), ".codex", "config.toml");
  }
}

/**
 * Which identity a tool's existing komnet entry resolves to, or null if it has
 * none. `"<default>"` stands for "no KOMNET_HOME", which is the default home.
 */
async function configuredIdentity(target: SetupTarget, cwd: string): Promise<string | null> {
  const path = configPathOf(target, cwd);
  if (target === "codex") {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return null;
    }
    const section = tomlSection(raw, "mcp_servers.komnet");
    if (section === null) return null;
    const body = raw.slice(section.bodyStart, section.end);
    return /KOMNET_HOME\s*=\s*"([^"]+)"/.exec(body)?.[1] ?? "<default>";
  }
  const config = await readJson(path);
  const server = (config?.["mcpServers"] as Record<string, unknown> | undefined)?.["komnet"] as
    { env?: Record<string, string> } | undefined;
  if (server === undefined) return null;
  return server.env?.["KOMNET_HOME"] ?? "<default>";
}

/**
 * Other tools already pointed at the identity this one is about to use.
 *
 * The footgun is documented, and a footgun whose failure mode is **total
 * silence** deserves a runtime check rather than a paragraph: routing never
 * returns a message to its author, so two tools sharing one agent id drop
 * every message they send each other — no error, no queue, nothing in either
 * inbox, and no way to tell that from a peer who is simply not answering.
 */
async function toolsSharingIdentity(
  target: SetupTarget,
  agentHome: string | undefined,
  cwd: string,
): Promise<SetupTarget[]> {
  const mine = agentHome ?? "<default>";
  const sharing: SetupTarget[] = [];
  for (const other of SETUP_TARGETS) {
    if (other === target) continue;
    const theirs = await configuredIdentity(other, cwd).catch(() => null);
    if (theirs !== null && theirs === mine) sharing.push(other);
  }
  return sharing;
}

export async function setupTool(
  target: SetupTarget,
  options: SetupOptions = {},
): Promise<SetupResult> {
  const cwd = options.cwd ?? process.cwd();
  const agentHome = options.agentHome;
  const changes: SetupChange[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];

  const sharing = await toolsSharingIdentity(target, agentHome, cwd);
  if (sharing.length > 0) {
    warnings.push(
      `${sharing.join(" and ")} already use this same komnet identity` +
        `${agentHome === undefined ? " (the default home)" : ` (${agentHome})`}. ` +
        "Messages between these tools will be silently dropped — routing never delivers a message " +
        "back to its own author, so neither side sees an error or an inbox item. " +
        `Give each tool its own: komnet agent add <id> --repo <transport> && komnet setup ${target} --agent <id>`,
    );
  }

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
  return { target, changes, notes, warnings };
}

/** Remove only the standalone integration written by `setupTool`. */
export async function uninstallTool(
  target: SetupTarget,
  options: Pick<SetupOptions, "cwd"> = {},
): Promise<SetupResult> {
  const cwd = options.cwd ?? process.cwd();
  const changes: SetupChange[] = [];
  const notes: string[] = [];

  switch (target) {
    case "claude-code": {
      changes.push(await removeMcpServer(join(cwd, ".mcp.json"), "MCP server entry"));
      changes.push(await removeClaudeHooks(join(cwd, ".claude", "settings.json")));
      notes.push("Restart Claude Code to unload the standalone server and hooks.");
      break;
    }
    case "claude-desktop": {
      changes.push(await removeMcpServer(claudeDesktopConfigPath(), "MCP server entry"));
      notes.push("Quit and reopen Claude Desktop to unload the server.");
      break;
    }
    case "cursor": {
      changes.push(await removeMcpServer(join(cwd, ".cursor", "mcp.json"), "MCP server entry"));
      notes.push("Reload Cursor to unload the server.");
      break;
    }
    case "codex": {
      changes.push(await removeCodex());
      notes.push("Restart Codex to unload the server.");
      break;
    }
  }

  notes.push("KomNet data, the CLI, daemon service, and marketplace plugins were not removed.");
  return { target, changes, notes, warnings: [] };
}
