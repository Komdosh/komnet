import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { assertAgentId } from "@kom-net/protocol";
import type { AgentIdentity } from "../config.ts";

/**
 * An agent's published identity on `main` — how one agent decides whom to ask.
 *
 * An agent writes ONLY its own card; writing another's is a protocol violation
 * (ADR 0004), which is what keeps this directory conflict-free.
 */
export interface AgentCard {
  v: number;
  id: string;
  displayName: string;
  human: { name: string; timezone: string; workingHours?: string };
  tool: string;
  /**
   * The git identity this agent commits with.
   *
   * This is the binding `authenticity: git` checks: without it, `from` is just
   * a string anyone with push access can write.
   */
  gitAuthor?: { name: string; email: string };
  expertise: string[];
  /** Repos or services this agent can actually answer about. */
  speaksFor: string[];
  presence: { status: "live" | "away"; lastSeen: string };
}

export function cardFromIdentity(
  identity: AgentIdentity,
  extras: {
    expertise?: string[];
    speaksFor?: string[];
    gitAuthor?: { name: string; email: string };
  } = {},
): AgentCard {
  return {
    v: 1,
    id: identity.id,
    displayName: identity.displayName,
    human: { name: identity.human.name, timezone: identity.human.timezone },
    tool: identity.tool,
    ...(extras.gitAuthor === undefined ? {} : { gitAuthor: extras.gitAuthor }),
    expertise: extras.expertise ?? [],
    speaksFor: extras.speaksFor ?? [],
    // Published on transition only, never as a heartbeat — a beat would
    // generate more commits than actual conversation.
    presence: { status: "away", lastSeen: new Date().toISOString() },
  };
}

export function serializeAgentCard(card: AgentCard): string {
  return stringifyYaml(
    {
      v: card.v,
      id: card.id,
      display_name: card.displayName,
      human: {
        name: card.human.name,
        timezone: card.human.timezone,
        ...(card.human.workingHours === undefined
          ? {}
          : { working_hours: card.human.workingHours }),
      },
      tool: card.tool,
      ...(card.gitAuthor === undefined
        ? {}
        : { git_author: { name: card.gitAuthor.name, email: card.gitAuthor.email } }),
      expertise: card.expertise,
      speaks_for: card.speaksFor,
      presence: { status: card.presence.status, last_seen: card.presence.lastSeen },
    },
    { lineWidth: 0 },
  );
}

export function parseAgentCard(raw: string): AgentCard {
  const y = parseYaml(raw) as Record<string, unknown> | null;
  if (y === null || typeof y !== "object") throw new Error("agent card is not a YAML mapping");
  const human = (y["human"] ?? {}) as Record<string, unknown>;
  const presence = (y["presence"] ?? {}) as Record<string, unknown>;
  const id = String(y["id"] ?? "");
  assertAgentId(id);

  const card: AgentCard = {
    v: Number(y["v"] ?? 1),
    id,
    displayName: String(y["display_name"] ?? id),
    human: {
      name: String(human["name"] ?? "unknown"),
      timezone: String(human["timezone"] ?? "UTC"),
    },
    tool: String(y["tool"] ?? "unknown"),
    expertise: Array.isArray(y["expertise"]) ? (y["expertise"] as string[]) : [],
    speaksFor: Array.isArray(y["speaks_for"]) ? (y["speaks_for"] as string[]) : [],
    presence: {
      status: presence["status"] === "live" ? "live" : "away",
      lastSeen: String(presence["last_seen"] ?? new Date(0).toISOString()),
    },
  };
  const gitAuthor = y["git_author"] as { name?: unknown; email?: unknown } | undefined;
  if (gitAuthor !== undefined && typeof gitAuthor.email === "string") {
    card.gitAuthor = { name: String(gitAuthor.name ?? ""), email: gitAuthor.email };
  }
  if (typeof human["working_hours"] === "string") {
    card.human.workingHours = human["working_hours"];
  }
  return card;
}
