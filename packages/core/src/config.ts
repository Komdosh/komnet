import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { assertAgentId, assertRoomId } from "@kom-net/protocol";

/** Who this machine is on every network it joins. */
export interface AgentIdentity {
  id: string;
  displayName: string;
  human: { name: string; timezone: string };
  tool: string;
}

export interface NetworkConfig {
  id: string;
  remote: string;
  /**
   * Rooms this agent follows. Local on purpose: subscriptions change often,
   * are nobody else's business, and publishing them would mean a write to
   * shared state for a purely local decision.
   */
  subscriptions: string[];
}

export interface KomnetConfig {
  v: number;
  agent: AgentIdentity;
  networks: Record<string, NetworkConfig>;
  defaultNetwork: string | null;
}

export const CONFIG_VERSION = 1;

export function defaultIdentity(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  const human = overrides.human?.name ?? process.env["USER"] ?? "unknown";
  const tool = overrides.tool ?? "cli";
  return {
    id: overrides.id ?? `${human}-${tool}`,
    displayName: overrides.displayName ?? `${human}'s ${tool}`,
    human: {
      name: human,
      timezone:
        overrides.human?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    },
    tool,
  };
}

export function emptyConfig(agent: AgentIdentity): KomnetConfig {
  return { v: CONFIG_VERSION, agent, networks: {}, defaultNetwork: null };
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

  const networks = parsed.networks ?? {};
  for (const net of Object.values(networks)) {
    for (const room of net.subscriptions ?? []) assertRoomId(room);
  }

  return {
    v: parsed.v ?? CONFIG_VERSION,
    agent,
    networks,
    defaultNetwork: parsed.defaultNetwork ?? null,
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
