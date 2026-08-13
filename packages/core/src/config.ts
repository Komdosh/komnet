import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { assertAgentId, assertCanonicalRepositoryId, assertRoomId } from "@komnet/protocol";

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

export interface LocalRepositoryConfig {
  /** Absolute path to an existing local git worktree. Never received from the wire. */
  path: string;
  /** Optional local git remote name. Its presence authorises fetching missing objects. */
  fetchRemote?: string;
}

export interface LocalReviewPolicy {
  /** Prepared detached worktrees kept at once on this machine. */
  maxPreparedWorktrees: number;
}

export const DEFAULT_LOCAL_REVIEW_POLICY: LocalReviewPolicy = {
  maxPreparedWorktrees: 1,
};

export interface KomnetConfig {
  v: number;
  agent: AgentIdentity;
  networks: Record<string, NetworkConfig>;
  defaultNetwork: string | null;
  repositories: Record<string, LocalRepositoryConfig>;
  review: LocalReviewPolicy;
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
  return {
    v: CONFIG_VERSION,
    agent,
    networks: {},
    defaultNetwork: null,
    repositories: {},
    review: { ...DEFAULT_LOCAL_REVIEW_POLICY },
  };
}

export function isGitRemoteName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.includes("..");
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

  const repositories = parsed.repositories ?? {};
  if (typeof repositories !== "object" || Array.isArray(repositories)) {
    throw new Error(`${path}: 'repositories' must be a mapping`);
  }
  for (const [id, mapping] of Object.entries(repositories)) {
    assertCanonicalRepositoryId(id);
    if (mapping === null || typeof mapping !== "object" || Array.isArray(mapping)) {
      throw new Error(`${path}: repository ${id} must be a mapping`);
    }
    if (typeof mapping.path !== "string" || !isAbsolute(mapping.path)) {
      throw new Error(`${path}: repository ${id} path must be absolute`);
    }
    if (
      mapping.fetchRemote !== undefined &&
      (typeof mapping.fetchRemote !== "string" || !isGitRemoteName(mapping.fetchRemote))
    ) {
      throw new Error(`${path}: repository ${id} fetchRemote is not a safe git remote name`);
    }
  }

  const reviewValue: unknown = parsed.review;
  if (
    reviewValue !== undefined &&
    (reviewValue === null || typeof reviewValue !== "object" || Array.isArray(reviewValue))
  ) {
    throw new Error(`${path}: 'review' must be a mapping`);
  }
  const review = (reviewValue ?? DEFAULT_LOCAL_REVIEW_POLICY) as Partial<LocalReviewPolicy>;
  const maxPreparedWorktrees = review.maxPreparedWorktrees ?? 1;
  if (
    !Number.isInteger(maxPreparedWorktrees) ||
    maxPreparedWorktrees < 1 ||
    maxPreparedWorktrees > 32
  ) {
    throw new Error(`${path}: review.maxPreparedWorktrees must be an integer from 1 to 32`);
  }

  return {
    v: parsed.v ?? CONFIG_VERSION,
    agent,
    networks,
    defaultNetwork: parsed.defaultNetwork ?? null,
    repositories,
    review: { maxPreparedWorktrees },
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
