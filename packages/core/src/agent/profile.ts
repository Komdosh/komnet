import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { assertAgentId } from "@komnet/protocol";
import type { AgentIdentity } from "../config.ts";
import type { AgentCard } from "./card.ts";

const PROFILE_VERSION = 1;
const MAX_ROLE_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 500;
const MAX_LIST_ITEMS = 20;
const MAX_LIST_ITEM_LENGTH = 240;

export interface AgentProfileEnvironment {
  /** Connection surface that observed this environment, such as `mcp` or `cli`. */
  client: string;
  platform: string;
  architecture: string;
  /** Safe shared label or canonical repository id. Never an absolute local path. */
  workspace?: string;
}

/**
 * An agent's cooperative self-description.
 *
 * Unlike the agent card, none of these statements grant identity or authority.
 * They make division of work faster by publishing current, bounded claims.
 */
export interface AgentProfile {
  v: 1;
  id: string;
  updatedAt: string;
  role: string;
  mission: string;
  currentFocus: string;
  environment: AgentProfileEnvironment;
  capabilities: string[];
  responsibilities: string[];
  constraints: string[];
  canHelpWith: string[];
}

export interface AgentProfileUpdate {
  role?: string;
  mission?: string;
  currentFocus?: string;
  capabilities?: readonly string[];
  responsibilities?: readonly string[];
  constraints?: readonly string[];
  canHelpWith?: readonly string[];
  /** Null removes a previously declared workspace label. */
  workspace?: string | null;
}

/** Existing card fields plus the scan-friendly role used for peer discovery. */
export type AgentDirectoryEntry = AgentCard & { role?: string };

/** Environment facts observed by the local connection, never read from a peer. */
export interface AgentRuntimeEnvironment {
  client: string;
  platform: string;
  architecture: string;
}

function oneLine(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`agent profile '${field}' must be a string`);
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) throw new Error(`agent profile '${field}' must not be empty`);
  if (normalized.length > maxLength) {
    throw new Error(`agent profile '${field}' must be at most ${String(maxLength)} characters`);
  }
  return normalized;
}

function list(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`agent profile '${field}' must be an array`);
  if (value.length > MAX_LIST_ITEMS) {
    throw new Error(
      `agent profile '${field}' must contain at most ${String(MAX_LIST_ITEMS)} items`,
    );
  }
  return value.map((entry, index) =>
    oneLine(entry, `${field}[${String(index)}]`, MAX_LIST_ITEM_LENGTH),
  );
}

function environment(value: unknown): AgentProfileEnvironment {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("agent profile 'environment' must be a mapping");
  }
  const record = value as Record<string, unknown>;
  const workspace = record["workspace"];
  return {
    client: oneLine(record["client"], "environment.client", MAX_ROLE_LENGTH),
    platform: oneLine(record["platform"], "environment.platform", MAX_ROLE_LENGTH),
    architecture: oneLine(record["architecture"], "environment.architecture", MAX_ROLE_LENGTH),
    ...(workspace === undefined ? {} : { workspace: workspaceLabel(workspace) }),
  };
}

function workspaceLabel(value: unknown): string {
  const label = oneLine(value, "environment.workspace", MAX_SUMMARY_LENGTH);
  if (
    /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/])/.test(label) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(label) ||
    label.includes("\\") ||
    /[`;$@:]/.test(label) ||
    label.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error(
      "agent profile 'environment.workspace' must be a safe label or canonical repository id, not a local path",
    );
  }
  return label;
}

function defaultProfile(identity: AgentIdentity): AgentProfile {
  return {
    v: PROFILE_VERSION,
    id: identity.id,
    updatedAt: new Date().toISOString(),
    role: `${identity.tool} engineering agent`,
    mission: `Help ${identity.human.name} achieve engineering goals through reliable cooperation.`,
    currentFocus: "Connected and available for collaboration.",
    environment: { client: identity.tool, platform: "unknown", architecture: "unknown" },
    capabilities: [
      "Read shared KomNet context",
      "Coordinate messages, tasks, reviews, and decisions as this agent",
    ],
    responsibilities: [
      "Advance the connected human's goals",
      "Keep commitments, limitations, and progress explicit",
    ],
    constraints: ["Acts only within the tools and permissions granted by the current host session"],
    canHelpWith: [],
  };
}

/**
 * Whether this profile still says only what komnet filled in for it.
 *
 * The default is deliberately generic — `claude-code engineering agent`,
 * "Help someone achieve engineering goals" — because it has to be true of an
 * agent that has told us nothing. The cost is that a network of untouched
 * profiles looks populated while carrying no information: "who owns auth?" is
 * the first question anyone asks komnet, and boilerplate answers it with
 * everyone, which is the same as nobody. Detecting it is what lets `doctor` say
 * so instead of reporting a full directory of blanks as healthy.
 */
export function isDefaultProfile(profile: AgentProfile, identity: AgentIdentity): boolean {
  const template = defaultProfile(identity);
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  return (
    profile.role === template.role &&
    profile.canHelpWith.length === 0 &&
    same(profile.capabilities, template.capabilities) &&
    same(profile.responsibilities, template.responsibilities)
  );
}

/** Merge a partial self-description while preserving fields the agent did not revisit. */
export function profileFromIdentity(
  identity: AgentIdentity,
  previous: AgentProfile | null,
  update: AgentProfileUpdate = {},
  runtime?: AgentRuntimeEnvironment,
  now = new Date(),
): AgentProfile {
  assertAgentId(identity.id);
  const base = previous ?? defaultProfile(identity);
  const workspace =
    update.workspace === null
      ? undefined
      : update.workspace === undefined
        ? base.environment.workspace
        : workspaceLabel(update.workspace);
  const next: AgentProfile = {
    v: PROFILE_VERSION,
    id: identity.id,
    updatedAt: now.toISOString(),
    role: update.role === undefined ? base.role : oneLine(update.role, "role", MAX_ROLE_LENGTH),
    mission:
      update.mission === undefined
        ? base.mission
        : oneLine(update.mission, "mission", MAX_SUMMARY_LENGTH),
    currentFocus:
      update.currentFocus === undefined
        ? base.currentFocus
        : oneLine(update.currentFocus, "current_focus", MAX_SUMMARY_LENGTH),
    environment: {
      client:
        runtime === undefined
          ? base.environment.client
          : oneLine(runtime.client, "environment.client", MAX_ROLE_LENGTH),
      platform:
        runtime === undefined
          ? base.environment.platform
          : oneLine(runtime.platform, "environment.platform", MAX_ROLE_LENGTH),
      architecture:
        runtime === undefined
          ? base.environment.architecture
          : oneLine(runtime.architecture, "environment.architecture", MAX_ROLE_LENGTH),
      ...(workspace === undefined ? {} : { workspace }),
    },
    capabilities:
      update.capabilities === undefined
        ? [...base.capabilities]
        : list(update.capabilities, "capabilities"),
    responsibilities:
      update.responsibilities === undefined
        ? [...base.responsibilities]
        : list(update.responsibilities, "responsibilities"),
    constraints:
      update.constraints === undefined
        ? [...base.constraints]
        : list(update.constraints, "constraints"),
    canHelpWith:
      update.canHelpWith === undefined
        ? [...base.canHelpWith]
        : list(update.canHelpWith, "can_help_with"),
  };
  return next;
}

function bullets(values: readonly string[], empty: string): string {
  return values.length === 0 ? `- ${empty}` : values.map((value) => `- ${value}`).join("\n");
}

/** Deterministic Markdown: structured frontmatter for clients, concise prose for people. */
export function serializeAgentProfile(profile: AgentProfile): string {
  const frontmatter = stringifyYaml(
    {
      v: profile.v,
      id: profile.id,
      updated_at: profile.updatedAt,
      role: profile.role,
      mission: profile.mission,
      current_focus: profile.currentFocus,
      environment: {
        client: profile.environment.client,
        platform: profile.environment.platform,
        architecture: profile.environment.architecture,
        ...(profile.environment.workspace === undefined
          ? {}
          : { workspace: profile.environment.workspace }),
      },
      capabilities: profile.capabilities,
      responsibilities: profile.responsibilities,
      constraints: profile.constraints,
      can_help_with: profile.canHelpWith,
    },
    { lineWidth: 0 },
  );
  const workspace =
    profile.environment.workspace === undefined
      ? ""
      : `\n- Workspace: ${profile.environment.workspace}`;
  return [
    "---",
    frontmatter.trimEnd(),
    "---",
    "",
    `# ${profile.id}`,
    "",
    `> ${profile.role}`,
    "",
    "## Mission",
    "",
    profile.mission,
    "",
    "## Current focus",
    "",
    profile.currentFocus,
    "",
    "## Environment",
    "",
    `- Client: ${profile.environment.client}`,
    `- Platform: ${profile.environment.platform}`,
    `- Architecture: ${profile.environment.architecture}${workspace}`,
    "",
    "## Capabilities",
    "",
    bullets(profile.capabilities, "None declared yet"),
    "",
    "## Responsibilities",
    "",
    bullets(profile.responsibilities, "None declared yet"),
    "",
    "## Constraints",
    "",
    bullets(profile.constraints, "None declared yet"),
    "",
    "## Can help with",
    "",
    bullets(profile.canHelpWith, "Ask the agent to update this profile"),
    "",
  ].join("\n");
}

export function parseAgentProfile(raw: string): AgentProfile {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) throw new Error("agent profile has no frontmatter");
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) throw new Error("agent profile frontmatter is unterminated");
  const y = parseYaml(normalized.slice(4, end)) as Record<string, unknown> | null;
  if (y === null || typeof y !== "object" || Array.isArray(y)) {
    throw new Error("agent profile frontmatter is not a YAML mapping");
  }
  if (Number(y["v"]) !== PROFILE_VERSION) {
    throw new Error(`unsupported agent profile version ${String(y["v"])}`);
  }
  const id = String(y["id"] ?? "");
  assertAgentId(id);
  const updatedAt = oneLine(y["updated_at"], "updated_at", MAX_ROLE_LENGTH);
  if (!Number.isFinite(Date.parse(updatedAt))) {
    throw new Error("agent profile 'updated_at' must be an RFC 3339 timestamp");
  }
  return {
    v: PROFILE_VERSION,
    id,
    updatedAt,
    role: oneLine(y["role"], "role", MAX_ROLE_LENGTH),
    mission: oneLine(y["mission"], "mission", MAX_SUMMARY_LENGTH),
    currentFocus: oneLine(y["current_focus"], "current_focus", MAX_SUMMARY_LENGTH),
    environment: environment(y["environment"]),
    capabilities: list(y["capabilities"], "capabilities"),
    responsibilities: list(y["responsibilities"], "responsibilities"),
    constraints: list(y["constraints"], "constraints"),
    canHelpWith: list(y["can_help_with"], "can_help_with"),
  };
}

/** Timestamp-independent comparison prevents a commit on every connection. */
export function sameAgentProfile(left: AgentProfile, right: AgentProfile): boolean {
  const { updatedAt: _leftUpdatedAt, ...leftStable } = left;
  const { updatedAt: _rightUpdatedAt, ...rightStable } = right;
  return JSON.stringify(leftStable) === JSON.stringify(rightStable);
}
