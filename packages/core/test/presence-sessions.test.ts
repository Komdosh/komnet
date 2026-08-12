import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  liveSessions,
  observedPresenceStatus,
  parseAgentCard,
  reconcileSessions,
  serializeAgentCard,
  SESSION_STALE_AFTER_MS,
  type AgentCard,
} from "../src/index.ts";

const AT = (iso: string) => new Date(iso);
const T0 = "2026-08-12T10:00:00.000Z";

function presence(
  sessions: { id: string; since: string }[],
  status: "live" | "away" = "live",
): AgentCard["presence"] {
  return { status, lastSeen: T0, sessions };
}

/**
 * The agent id stays stable and routable, so two windows of one tool are the
 * same participant. These sessions are what tells them apart — and, more
 * importantly, what stops one of them leaving from announcing the other away.
 */
describe("concurrent session tracking", () => {
  it("keeps the agent live while another session is still attached", () => {
    const first = reconcileSessions([], { session: "a", status: "live" }, AT(T0));
    assert.equal(first.status, "live");

    const second = reconcileSessions(
      first.sessions,
      { session: "b", status: "live" },
      AT("2026-08-12T10:00:05.000Z"),
    );
    assert.equal(second.sessions.length, 2);

    // The bug this exists for: without the set, `a` exiting publishes away
    // while `b` is mid-task, and the network is told nobody is there.
    const aLeaves = reconcileSessions(
      second.sessions,
      { session: "a", status: "away" },
      AT("2026-08-12T10:00:10.000Z"),
    );
    assert.equal(aLeaves.status, "live", "one session leaving must not take the agent away");
    assert.deepEqual(
      aLeaves.sessions.map((s) => s.id),
      ["b"],
    );

    const bLeaves = reconcileSessions(
      aLeaves.sessions,
      { session: "b", status: "away" },
      AT("2026-08-12T10:00:20.000Z"),
    );
    assert.equal(bLeaves.status, "away", "the last session out transitions the agent away");
    assert.deepEqual(bLeaves.sessions, []);
  });

  it("re-announcing one session does not double-count it", () => {
    let state = reconcileSessions([], { session: "a", status: "live" }, AT(T0));
    state = reconcileSessions(state.sessions, { session: "a", status: "live" }, AT(T0));
    assert.equal(state.sessions.length, 1, "a session is a set member, not an increment");
  });

  it("treats an unnamed declaration as speaking for the whole agent", () => {
    const attached = reconcileSessions([], { session: "a", status: "live" }, AT(T0));

    // `komnet presence --away` has no session to name; it must mean all of them,
    // or the flag does not do what it says.
    const blunt = reconcileSessions(attached.sessions, { status: "away" }, AT(T0));
    assert.equal(blunt.status, "away");
    assert.deepEqual(blunt.sessions, []);
  });

  it("drops a session that outlived the tracking window", () => {
    const stale = new Date(Date.parse(T0) - SESSION_STALE_AFTER_MS - 1_000).toISOString();
    const state = reconcileSessions(
      [{ id: "crashed", since: stale }],
      { session: "fresh", status: "live" },
      AT(T0),
    );
    assert.deepEqual(
      state.sessions.map((s) => s.id),
      ["fresh"],
      "a crashed session never publishes its departure, so it must age out",
    );
  });

  it("goes away when the only remaining session had already aged out", () => {
    const stale = new Date(Date.parse(T0) - SESSION_STALE_AFTER_MS - 1_000).toISOString();
    const state = reconcileSessions(
      [{ id: "crashed", since: stale }],
      { session: "crashed", status: "away" },
      AT(T0),
    );
    assert.equal(state.status, "away");
    assert.deepEqual(state.sessions, []);
  });

  it("bounds how many sessions one card can carry", () => {
    let sessions: { id: string; since: string }[] = [];
    for (let i = 0; i < 50; i++) {
      sessions = reconcileSessions(
        sessions,
        { session: `s${String(i)}`, status: "live" },
        AT(T0),
      ).sessions;
    }
    assert.ok(sessions.length <= 32, `expected a bounded set, got ${String(sessions.length)}`);
    assert.ok(
      sessions.some((s) => s.id === "s49"),
      "eviction must be oldest-first, keeping the newest",
    );
  });

  it("reports only sessions inside the window", () => {
    const stale = new Date(Date.now() - SESSION_STALE_AFTER_MS - 1_000).toISOString();
    const fresh = new Date().toISOString();
    const live = liveSessions(
      presence([
        { id: "old", since: stale },
        { id: "new", since: fresh },
      ]),
    );
    assert.deepEqual(
      live.map((s) => s.id),
      ["new"],
    );
  });
});

describe("agent card wire format", () => {
  it("round-trips sessions", () => {
    const card = parseAgentCard(
      serializeAgentCard({
        v: 1,
        id: "komdosh-claude",
        displayName: "claude",
        human: { name: "komdosh", timezone: "Europe/Moscow" },
        tool: "claude-code",
        expertise: [],
        speaksFor: [],
        presence: presence([
          { id: "a", since: T0 },
          { id: "b", since: T0 },
        ]),
      }),
    );
    assert.deepEqual(
      card.presence.sessions.map((s) => s.id),
      ["a", "b"],
    );
    assert.equal(card.presence.status, "live");
  });

  it("omits the field entirely when no session is attached", () => {
    const yaml = serializeAgentCard({
      v: 1,
      id: "komdosh-codex",
      displayName: "codex",
      human: { name: "komdosh", timezone: "Europe/Moscow" },
      tool: "codex",
      expertise: [],
      speaksFor: [],
      presence: presence([], "away"),
    });
    assert.doesNotMatch(
      yaml,
      /sessions/,
      "an agent with no sessions writes the card it always did",
    );
  });

  it("reads a card written before sessions existed", () => {
    // Forward compatibility in the direction that actually happens: an older
    // build's card must not become unreadable to a newer one.
    const legacy = [
      "v: 1",
      "id: legacy-agent",
      "display_name: legacy",
      "human:",
      "  name: someone",
      "  timezone: UTC",
      "tool: cli",
      "expertise: []",
      "speaks_for: []",
      "presence:",
      "  status: live",
      `  last_seen: ${T0}`,
      "",
    ].join("\n");

    const card = parseAgentCard(legacy);
    assert.deepEqual(card.presence.sessions, []);
    assert.equal(card.presence.status, "live");
    assert.equal(observedPresenceStatus(card.presence, Date.parse(T0)), "live");
  });

  it("ignores malformed session entries rather than failing the whole card", () => {
    const raw = [
      "v: 1",
      "id: odd-agent",
      "display_name: odd",
      "human: { name: someone, timezone: UTC }",
      "tool: cli",
      "expertise: []",
      "speaks_for: []",
      "presence:",
      "  status: live",
      `  last_seen: ${T0}`,
      "  sessions:",
      "    - id: good",
      `      since: ${T0}`,
      "    - notanobject",
      "    - since: 2026-01-01T00:00:00.000Z",
      "",
    ].join("\n");

    const card = parseAgentCard(raw);
    assert.deepEqual(
      card.presence.sessions.map((s) => s.id),
      ["good"],
      "one bad entry from another machine must not make the roster unreadable",
    );
  });
});
