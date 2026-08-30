import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { assertAgentId, isMachineId, machineFromToken } from "@komnet/protocol";
import type { AgentIdentity, MachineIdentity } from "../config.ts";

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
   * The computer this agent runs on.
   *
   * This is what makes "ask whoever is on the box that runs checkout"
   * expressible. One person routinely runs Claude, Codex and a CLI at once, and
   * each registers under its own id — so a roster of nine entries is really
   * three computers, and a sender who wants a particular *workspace* has to
   * guess which of three strangers is sitting in it.
   *
   * **Undefined is not "unknown machine".** A card written by a client that
   * predates this field carries no machine, and inventing one would put an
   * agent in a group it never claimed. Readers group those separately and say
   * so, the same discipline `subscriptions` follows (ADR 0021).
   *
   * Cooperative, never authenticated: an agent writes its own card, so this
   * claims a machine rather than proving one.
   */
  machine?: MachineIdentity;
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
  /**
   * Rooms this agent follows, so a sender can tell whether a message will land.
   *
   * Routing delivers only within subscriptions, and subscriptions used to be
   * purely local — so mentioning an agent that had never joined the room
   * produced silence indistinguishable from being ignored. Publishing them
   * makes the common mistake visible before it wastes a day.
   *
   * **Undefined is not "none".** A card written by a client that predates this
   * field carries no list, and treating that as "subscribes to nothing" would
   * invent a confident wrong answer. Readers must report unknown instead.
   *
   * Still a hint, not a guarantee: a peer may have joined a second ago and not
   * pushed yet. The reliable direction is the negative — a room absent from a
   * freshly published card is one this agent is very unlikely to be reading.
   */
  subscriptions?: string[];
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
 * Presence is **derived from when an agent was last seen**, not from a bit it
 * remembered to clear.
 *
 * The card records one durable fact — *this agent was here at this timestamp* —
 * and every reader ages it into an answer. Nothing has to publish a departure,
 * which matters because a departure is the write nobody is around to make: a
 * crashed daemon, a closed laptop, and a killed editor all leave the same
 * silence, and the old model answered that silence with a `live` bit that
 * stayed true until someone happened to correct it. Deriving from the timestamp
 * gets the same answer from the evidence already on the card, and it costs the
 * network nothing — an agent going away is exactly an agent that stops writing.
 *
 * The other half of the cost is what this avoids: there is no heartbeat. Every
 * refresh would be a commit on `main`, the branch that is meant to stay cold,
 * so `last_seen` moves only when a session actually arrives — and
 * `observedPresenceWithActivity` fills the long silence in between from
 * messages the agent wrote anyway.
 *
 * Three answers, because two would be a lie in the middle:
 *
 * - seen within `liveWithinMs` → `live`
 * - between the two windows → `stale`, meaning *we do not know*
 * - not seen for `awayAfterMs` → `away`
 */
export const PRESENCE_LIVE_WITHIN_MS = 5 * 60_000;
export const PRESENCE_AWAY_AFTER_MS = 10 * 60_000;
const PRESENCE_FUTURE_SKEW_MS = 60_000;
export type PresenceStatus = "live" | "away" | "stale";

export interface PresenceWindows {
  liveWithinMs: number;
  awayAfterMs: number;
}

export const DEFAULT_PRESENCE_WINDOWS: PresenceWindows = {
  liveWithinMs: PRESENCE_LIVE_WITHIN_MS,
  awayAfterMs: PRESENCE_AWAY_AFTER_MS,
};

function fromAge(ageMs: number, windows: PresenceWindows): PresenceStatus {
  if (ageMs <= windows.liveWithinMs) return "live";
  if (ageMs <= windows.awayAfterMs) return "stale";
  return "away";
}

export function observedPresenceStatus(
  presence: AgentCard["presence"],
  now = Date.now(),
  windows: PresenceWindows = DEFAULT_PRESENCE_WINDOWS,
): PresenceStatus {
  // An explicit `away` is a declaration, not an inference — the one case where
  // an agent has actually told the network it is leaving, so it is believed
  // without ageing anything.
  if (presence.status === "away") return "away";
  const lastSeen = Date.parse(presence.lastSeen);
  // A stamp we cannot read, or one from the future, is not evidence of anything
  // — including of absence. Say so instead of guessing in either direction.
  if (!Number.isFinite(lastSeen) || lastSeen - now > PRESENCE_FUTURE_SKEW_MS) return "stale";
  return fromAge(now - lastSeen, windows);
}

/**
 * Presence derived from the newest evidence, card or message.
 *
 * This is what makes a heartbeat unnecessary. The card is stamped once, when a
 * session attaches, so a session attached for a working day would age out while
 * the agent is mid-task — and peers act on that, treating a working colleague
 * as absent. A message is better evidence anyway (the card records a
 * declaration; a message records an act), and it was fetched already, so it
 * costs no commits.
 *
 * The same windows apply to it: a message from an hour ago says `away`, because
 * it is evidence of when it was written, not of now. Only activity *newer* than
 * the card counts, so an explicit `away` published after the last message still
 * reads as away — a departure is not undone by what preceded it.
 *
 * `lastActivityAt` is the newest message this agent authored in any room the
 * reader subscribes to, so the answer is only ever as good as the reader's own
 * subscriptions. That is the honest bound: it can miss activity in rooms the
 * reader cannot see, and it never invents presence that was not written down.
 */
export function observedPresenceWithActivity(
  presence: AgentCard["presence"],
  lastActivityAt: number | null,
  now = Date.now(),
  windows: PresenceWindows = DEFAULT_PRESENCE_WINDOWS,
): PresenceStatus {
  const declared = Date.parse(presence.lastSeen);
  const declaredAt = Number.isFinite(declared) ? declared : null;
  // A message is better evidence than a card, but only a message written after
  // it: the card may carry a deliberate departure, and what preceded a goodbye
  // does not undo it.
  if (
    lastActivityAt !== null &&
    (declaredAt === null || lastActivityAt > declaredAt) &&
    lastActivityAt - now <= PRESENCE_FUTURE_SKEW_MS
  ) {
    return fromAge(Math.max(0, now - lastActivityAt), windows);
  }
  return observedPresenceStatus(presence, now, windows);
}

/**
 * Cap on remembered sessions, and how long a session may sit unrefreshed.
 *
 * A session that crashes never publishes its own departure, so without a bound
 * one lost process would keep an agent looking live forever. This is generous
 * because a legitimate session can be attached for a whole working day, and the
 * damage it bounds is small: presence is derived from `last_seen`, so a leaked
 * entry inflates a session count rather than faking presence.
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

  if (change.status === "away") {
    sessions = sessions.filter((session) => session.id !== change.session);
  } else if (!sessions.some((session) => session.id === change.session)) {
    sessions = [...sessions, { id: change.session, since: now.toISOString() }];
    // Oldest-first eviction; a runaway caller cannot grow the card without bound.
    if (sessions.length > MAX_TRACKED_SESSIONS) {
      sessions = sessions.slice(sessions.length - MAX_TRACKED_SESSIONS);
    }
  }
  // An already-tracked session announcing itself again is left exactly as it
  // was, `since` included. The card writer decides whether to commit by
  // comparing the serialised card, so refreshing that timestamp would turn
  // every repeat announcement into a commit and a push on `main` — presence
  // chatter with no transition behind it.
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
    subscriptions?: string[];
  } = {},
): AgentCard {
  return {
    v: 1,
    id: identity.id,
    displayName: identity.displayName,
    human: { name: identity.human.name, timezone: identity.human.timezone },
    tool: identity.tool,
    machine: { id: identity.machine.id, label: identity.machine.label },
    ...(extras.gitAuthor === undefined ? {} : { gitAuthor: extras.gitAuthor }),
    expertise: extras.expertise ?? [],
    speaksFor: extras.speaksFor ?? [],
    ...(extras.subscriptions === undefined ? {} : { subscriptions: [...extras.subscriptions] }),
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
      ...(card.machine === undefined
        ? {}
        : { machine: { id: card.machine.id, label: card.machine.label } }),
      ...(card.gitAuthor === undefined
        ? {}
        : { git_author: { name: card.gitAuthor.name, email: card.gitAuthor.email } }),
      expertise: card.expertise,
      speaks_for: card.speaksFor,
      ...(card.subscriptions === undefined ? {} : { subscriptions: card.subscriptions }),
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
    // Absent stays absent: an older card says nothing about its subscriptions,
    // and turning that into an empty list would assert "reads nothing".
    ...(Array.isArray(y["subscriptions"])
      ? { subscriptions: (y["subscriptions"] as unknown[]).filter((r) => typeof r === "string") }
      : {}),
    presence: {
      status: presence["status"] === "live" ? "live" : "away",
      lastSeen: String(presence["last_seen"] ?? new Date(0).toISOString()),
      sessions: parseSessions(presence["sessions"]),
    },
  };
  const machine = y["machine"] as { id?: unknown; label?: unknown } | undefined;
  if (machine !== undefined && typeof machine.id === "string" && isMachineId(machine.id)) {
    // A malformed machine id leaves the field absent rather than becoming a
    // group of one: "we do not know" is the honest reading of an unusable claim.
    card.machine = { id: machine.id, label: String(machine.label ?? machine.id) };
  }
  const gitAuthor = y["git_author"] as { name?: unknown; email?: unknown } | undefined;
  if (gitAuthor !== undefined && typeof gitAuthor.email === "string") {
    card.gitAuthor = { name: String(gitAuthor.name ?? ""), email: gitAuthor.email };
  }
  if (typeof human["working_hours"] === "string") {
    card.human.workingHours = human["working_hours"];
  }
  return card;
}

/**
 * Replace every `machine:<id>` token with the agents actually on that machine,
 * keeping the token itself.
 *
 * Both halves matter. Expanding is what makes machine addressing work against
 * peers that have never heard of it: they match their own id in `mentions` and
 * deliver exactly as before, so a machine mention is not a message that only
 * newer builds can receive. Keeping the token is what makes it work for an
 * agent the *sender* has not fetched yet — a session that registered on that
 * machine after this roster was pulled still matches the token locally, and the
 * record shows what was actually addressed rather than a snapshot of who
 * happened to be listed at the time.
 *
 * Order is preserved and duplicates are dropped, so a message mentioning both
 * an agent and its machine names it once.
 */
export function expandMachineMentions(
  mentions: readonly string[],
  cards: readonly AgentCard[],
): string[] {
  const byMachine = new Map<string, string[]>();
  for (const card of cards) {
    if (card.machine === undefined) continue;
    const existing = byMachine.get(card.machine.id);
    if (existing === undefined) byMachine.set(card.machine.id, [card.id]);
    else existing.push(card.id);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    if (seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };

  for (const mention of mentions) {
    push(mention);
    const machineId = machineFromToken(mention);
    if (machineId === null) continue;
    for (const agentId of byMachine.get(machineId) ?? []) push(agentId);
  }
  return out;
}

/** Agent ids on one machine, in roster order. */
export function agentsOnMachine(cards: readonly AgentCard[], machineId: string): string[] {
  return cards.filter((card) => card.machine?.id === machineId).map((card) => card.id);
}
