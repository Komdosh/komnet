import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { assertAgentId } from "@komnet/protocol";
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
  presence: {
    status: "live" | "away";
    lastSeen: string;
    /**
     * The concurrently-attached sessions behind this one agent id.
     *
     * The id stays stable and routable — `komdosh-claude`, not a per-session
     * name — because a mention has to be addressable before the agent it names
     * has ever connected. Two windows of the same tool are therefore the same
     * participant, and this is what still tells them apart.
     *
     * It is also load-bearing rather than informational. Presence is published
     * on transition, so with a single boolean the first of two concurrent
     * sessions to exit publishes `away` while the other is still working, and
     * the network is told nobody is there. Tracking the set means only the last
     * session out transitions the agent away.
     */
    sessions: PresenceSession[];
  };
}

/** One attached session behind an agent id. */
export interface PresenceSession {
  /** Opaque, per-process. Never an identity, and never authenticated. */
  id: string;
  /** When this session announced itself, RFC 3339 UTC. */
  since: string;
}

/**
 * A remote `live` transition is only a hint: a crashed daemon cannot publish
 * the matching `away` transition. After this window we stop presenting the
 * persisted bit as current presence. No heartbeat commits are required.
 */
export const PRESENCE_STALE_AFTER_MS = 15 * 60_000;
const PRESENCE_FUTURE_SKEW_MS = 60_000;
export type PresenceStatus = "live" | "away" | "stale";

export function observedPresenceStatus(
  presence: AgentCard["presence"],
  now = Date.now(),
  staleAfterMs = PRESENCE_STALE_AFTER_MS,
): PresenceStatus {
  if (presence.status === "away") return "away";
  const lastSeen = Date.parse(presence.lastSeen);
  if (
    !Number.isFinite(lastSeen) ||
    lastSeen - now > PRESENCE_FUTURE_SKEW_MS ||
    now - lastSeen > staleAfterMs
  ) {
    return "stale";
  }
  return "live";
}

/**
 * Cap on remembered sessions, and how long a session may sit unrefreshed.
 *
 * A session that crashes never publishes its own departure, so without a bound
 * one lost process would keep an agent looking live forever. This is generous
 * because a legitimate session can be attached for a whole working day, and the
 * damage it bounds is small: `observedPresenceStatus` already degrades the card
 * to `stale` fifteen minutes after the last transition, so a leaked entry
 * inflates a session count rather than faking presence.
 */
export const SESSION_STALE_AFTER_MS = 12 * 60 * 60_000;
const MAX_TRACKED_SESSIONS = 32;

function parseSessions(raw: unknown): PresenceSession[] {
  if (!Array.isArray(raw)) return [];
  const sessions: PresenceSession[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = record["id"];
    if (typeof id !== "string" || id === "") continue;
    sessions.push({ id, since: String(record["since"] ?? new Date(0).toISOString()) });
  }
  return sessions;
}

/**
 * Apply one session's arrival or departure, and derive the resulting status.
 *
 * Pure so the decision is testable without git: everything hard about it is the
 * bookkeeping, not the writing. The status it returns is `live` while ANY
 * session remains, which is the whole point — the first of two concurrent
 * sessions to leave must not announce the agent away.
 */
export function reconcileSessions(
  existing: readonly PresenceSession[],
  change: { session?: string; status: "live" | "away" },
  now = new Date(),
): { status: "live" | "away"; sessions: PresenceSession[] } {
  const cutoff = now.getTime() - SESSION_STALE_AFTER_MS;
  let sessions = existing.filter((session) => {
    const since = Date.parse(session.since);
    return Number.isFinite(since) && since >= cutoff;
  });

  if (change.session === undefined) {
    // No session named: a blunt declaration, as `komnet presence --live/--away`
    // makes. Going away means all of them, or the flag would not do what it says.
    return { status: change.status, sessions: change.status === "away" ? [] : sessions };
  }

  sessions = sessions.filter((session) => session.id !== change.session);
  if (change.status === "live") {
    sessions.push({ id: change.session, since: now.toISOString() });
    // Oldest-first eviction; a runaway caller cannot grow the card without bound.
    if (sessions.length > MAX_TRACKED_SESSIONS) {
      sessions = sessions.slice(sessions.length - MAX_TRACKED_SESSIONS);
    }
  }
  return { status: sessions.length > 0 ? "live" : "away", sessions };
}

/** Sessions still within the tracking window, newest first. */
export function liveSessions(presence: AgentCard["presence"], now = Date.now()): PresenceSession[] {
  const cutoff = now - SESSION_STALE_AFTER_MS;
  return presence.sessions
    .filter((session) => {
      const since = Date.parse(session.since);
      return Number.isFinite(since) && since >= cutoff;
    })
    .sort((a, b) => b.since.localeCompare(a.since));
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
    presence: { status: "away", lastSeen: new Date().toISOString(), sessions: [] },
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
      presence: {
        status: card.presence.status,
        last_seen: card.presence.lastSeen,
        // Omitted entirely when empty, so a single-session agent's card is
        // byte-identical to one written by a build that predates sessions.
        ...(card.presence.sessions.length === 0
          ? {}
          : {
              sessions: card.presence.sessions.map((session) => ({
                id: session.id,
                since: session.since,
              })),
            }),
      },
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
      sessions: parseSessions(presence["sessions"]),
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
