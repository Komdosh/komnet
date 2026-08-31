import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  assertAgentId,
  assertMachineId,
  assertRoomId,
  isMachineId,
  slugify,
} from "@komnet/protocol";

/**
 * The computer several agents share.
 *
 * An agent id is per-session-tool — `komdosh-claude`, `komdosh-codex` — so a
 * developer running three assistants registers as three strangers, and a
 * teammate wanting "whoever is on the box that runs checkout" has no way to
 * say it. The machine is the thing that actually owns a checkout, a toolchain
 * and a running service, so it is what work and questions want to be addressed
 * to; the agents on it are interchangeable answerers.
 *
 * **Cooperative, never authenticated.** Like `needs: human` (ADR 0012), the id
 * is a label an agent writes about itself. It groups and routes; it proves
 * nothing. Authenticity stays with `git_author` on the card.
 */
export interface MachineIdentity {
  /** Stable, network-wide. Derived from the hostname unless a person sets it. */
  id: string;
  /** What the machine calls itself — the raw hostname. Display only. */
  label: string;
}

/** Who this machine is on every network it joins. */
export interface AgentIdentity {
  id: string;
  displayName: string;
  human: { name: string; timezone: string };
  tool: string;
  /**
   * The computer this agent runs on, shared with every other agent here.
   *
   * Derived identically on every agent home on the box (see
   * `defaultMachineIdentity`) rather than coordinated, because each local agent
   * has its own `KOMNET_HOME` and there is no shared file for them to agree in.
   */
  machine: MachineIdentity;
}

export interface NetworkConfig {
  id: string;
  remote: string;
  /**
   * Rooms this agent follows.
   *
   * The decision stays local — nobody else may change what this agent reads —
   * but it is no longer *private*: the list is published on the agent card so a
   * sender can tell whether a mention will actually be delivered. Routing has
   * always dropped messages into rooms the recipient never joined, and that
   * silence was indistinguishable from being ignored (ADR 0021).
   */
  subscriptions: string[];
}

/** Local routing context for one AI-desktop project directory. */
export interface ProjectBinding {
  /** A configured KomNet network, whose remote is the project's transport repository. */
  network: string;
  /** Advisory self-description published on that network; never an authority grant. */
  role: string;
}

export interface ResolvedProjectBinding extends ProjectBinding {
  /** Canonical local directory that owns the binding. Never published to the network. */
  path: string;
}

export interface KomnetConfig {
  v: number;
  agent: AgentIdentity;
  networks: Record<string, NetworkConfig>;
  defaultNetwork: string | null;
  /** Canonical local project directory -> network and advisory role. Machine-local only. */
  projects: Record<string, ProjectBinding>;
}

export const CONFIG_VERSION = 1;

/**
 * The machine id every agent on this computer computes independently.
 *
 * Derivation, not configuration, is the point: agents on one box each have
 * their own `KOMNET_HOME` (see `Layout.agentHomeDir`), so there is no shared
 * file for them to agree in, and asking a person to type the same id into three
 * homes is a step they will get wrong once and then debug for an hour.
 *
 * The hostname is the one fact all three already share. `komdosh-mbp.local` and
 * `komdosh-mbp` are the same computer, so the domain part is dropped before
 * slugifying — otherwise a machine would change identity when it moved between
 * networks that append different suffixes.
 *
 * Two different computers CAN derive the same id: generic hostnames like
 * `macbook-pro` are common. That is not silently papered over — the id is
 * overridable with `komnet machine set`, and `machineRoster` reports a machine
 * whose agents declare different humans as contested rather than presenting it
 * as one box.
 *
 * `KOMNET_MACHINE_ID` seeds the derivation for a home that has never been
 * configured, and is deliberately outranked by a stored id: a person who ran
 * `machine set` said what this computer is called, and a stray variable in one
 * shell must not quietly move an agent to a different machine.
 */
export function defaultMachineIdentity(overrides: Partial<MachineIdentity> = {}): MachineIdentity {
  const raw = overrides.label ?? hostname();
  const label = raw.trim().length === 0 ? "unknown" : raw.trim();
  const fromEnv = process.env["KOMNET_MACHINE_ID"];
  const explicit =
    overrides.id ?? (fromEnv !== undefined && isMachineId(fromEnv) ? fromEnv : undefined);
  const derived = slugify(label.split(".")[0] as string, 39);
  return { id: assertMachineId(explicit ?? derived ?? "unknown-machine"), label };
}

export function defaultIdentity(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  const human = overrides.human?.name ?? process.env["USER"] ?? "unknown";
  const tool = normalizeAgentTool(overrides.tool ?? "cli");
  return {
    id: overrides.id ?? `${human}-${tool}`,
    displayName: overrides.displayName ?? `${human}'s ${tool}`,
    human: {
      name: human,
      timezone:
        overrides.human?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    },
    tool,
    machine: defaultMachineIdentity(overrides.machine ?? {}),
  };
}

/** A compact, display-safe tool/client label carried on cards and profiles. */
export function normalizeAgentTool(value: unknown): string {
  if (typeof value !== "string") throw new Error("agent tool must be a string");
  const tool = value.replace(/\s+/g, " ").trim();
  if (tool.length === 0) throw new Error("agent tool must not be empty");
  if (tool.length > 64) throw new Error("agent tool must be at most 64 characters");
  return tool;
}

export function emptyConfig(agent: AgentIdentity): KomnetConfig {
  return {
    v: CONFIG_VERSION,
    agent,
    networks: {},
    defaultNetwork: null,
    projects: {},
  };
}

export function normalizeProjectRole(value: unknown): string {
  if (typeof value !== "string") throw new Error("project role must be a string");
  const role = value.replace(/\s+/g, " ").trim();
  if (role.length === 0) throw new Error("project role must not be empty");
  if (role.length > 120) throw new Error("project role must be at most 120 characters");
  return role;
}

export async function loadConfig(path: string): Promise<KomnetConfig | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = parseYaml(raw) as Partial<KomnetConfig> | null;
  if (parsed === null || typeof parsed !== "object") return null;

  const agent = parsed.agent;
  if (agent === undefined) throw new Error(`${path}: missing 'agent' section`);
  assertAgentId(agent.id);
  agent.tool = normalizeAgentTool(agent.tool ?? "cli");
  // A config written before machine identity carries none. Deriving it on load
  // — rather than migrating the file — means an older home keeps working, and
  // an agent that never runs `machine set` still lands in the right group.
  agent.machine =
    agent.machine === undefined
      ? defaultMachineIdentity()
      : defaultMachineIdentity({
          id: assertMachineId(agent.machine.id),
          ...(agent.machine.label === undefined ? {} : { label: agent.machine.label }),
        });

  const networks = parsed.networks ?? {};
  for (const net of Object.values(networks)) {
    for (const room of net.subscriptions ?? []) assertRoomId(room);
  }

  const projectsValue: unknown = parsed.projects ?? {};
  if (projectsValue === null || typeof projectsValue !== "object" || Array.isArray(projectsValue)) {
    throw new Error(`${path}: 'projects' must be a mapping`);
  }
  const projects: Record<string, ProjectBinding> = {};
  const roleByNetwork = new Map<string, { path: string; role: string }>();
  for (const [projectPath, value] of Object.entries(projectsValue)) {
    if (!isAbsolute(projectPath) || resolve(projectPath) !== projectPath) {
      throw new Error(`${path}: project path must be canonical and absolute: ${projectPath}`);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path}: project ${projectPath} must be a mapping`);
    }
    const binding = value as Record<string, unknown>;
    const network = binding["network"];
    if (typeof network !== "string" || networks[network] === undefined) {
      throw new Error(
        `${path}: project ${projectPath} names an unknown network ${String(network)}`,
      );
    }
    const role = normalizeProjectRole(binding["role"]);
    const existingRole = roleByNetwork.get(network);
    if (existingRole !== undefined && existingRole.role !== role) {
      throw new Error(
        `${path}: projects ${existingRole.path} and ${projectPath} assign different roles to network ${network}`,
      );
    }
    roleByNetwork.set(network, { path: projectPath, role });
    projects[projectPath] = { network, role };
  }

  return {
    v: parsed.v ?? CONFIG_VERSION,
    agent,
    networks,
    defaultNetwork: parsed.defaultNetwork ?? null,
    projects,
  };
}

export async function saveConfig(path: string, config: KomnetConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyYaml(config, { lineWidth: 0 }), { encoding: "utf8", mode: 0o600 });
}

/** Resolve which network a command applies to. */
export function resolveNetwork(config: KomnetConfig, requested?: string): NetworkConfig {
  const ids = Object.keys(config.networks);
  if (ids.length === 0) {
    throw new Error("no networks configured — run: komnet init --repo <url>");
  }
  if (requested !== undefined) {
    const net = config.networks[requested];
    if (net === undefined) {
      throw new Error(`unknown network ${JSON.stringify(requested)}; have: ${ids.join(", ")}`);
    }
    return net;
  }
  const fallback = config.defaultNetwork ?? (ids.length === 1 ? ids[0] : undefined);
  if (fallback === undefined) {
    throw new Error(`several networks configured; pass --network <id>. Have: ${ids.join(", ")}`);
  }
  return config.networks[fallback] as NetworkConfig;
}

/**
 * Resolve the most specific project binding containing `cwd`.
 *
 * Parent bindings cover nested folders, while a nested project can override
 * its parent. Paths stay local configuration and are never sent over KomNet.
 */
export function resolveProjectBinding(
  config: Pick<KomnetConfig, "projects">,
  cwd: string,
): ResolvedProjectBinding | null {
  const current = resolve(cwd);
  let best: ResolvedProjectBinding | null = null;
  for (const [projectPath, binding] of Object.entries(config.projects)) {
    const child = relative(projectPath, current);
    const contains =
      child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
    if (!contains || (best !== null && best.path.length >= projectPath.length)) continue;
    best = { path: projectPath, network: binding.network, role: binding.role };
  }
  return best;
}
