/**
 * Who is on the network, what they say they cover, and who is around.
 *
 * The card and profile formats are `../agent/card.ts` and `../agent/profile.ts`;
 * this is the half that writes them to `main` and reads the roster back.
 *
 * The card is the identity and authenticity record. A profile is cooperative
 * context for dividing work and grants no authority — the two are separate
 * files for that reason, not for tidiness.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  MAIN_REF,
  MENTION_MACHINE_PREFIX,
  agentCardPath,
  agentProfilePath,
  type Message,
} from "@komnet/protocol";

import { FileLock } from "../lock.ts";
import { SecretDetectedError } from "../errors.ts";
import { exists } from "../fs.ts";
import { scanForSecrets } from "../scanner/secrets.ts";
import {
  cardFromIdentity,
  expandMachineMentions,
  liveSessions,
  observedPresenceStatus,
  observedPresenceWithActivity,
  parseAgentCard,
  reconcileSessions,
  serializeAgentCard,
  type AgentCard,
  type PresenceStatus,
} from "../agent/card.ts";
import {
  parseAgentProfile,
  profileFromIdentity,
  sameAgentProfile,
  serializeAgentProfile,
  type AgentDirectoryEntry,
  type AgentProfile,
  type AgentProfileUpdate,
  type AgentRuntimeEnvironment,
} from "../agent/profile.ts";
import type { AgentIdentity } from "../config.ts";
import type { PresenceRow } from "../network.ts";
import type { Repo } from "../git/repo.ts";

const REMOTE = "origin";

/** Compare cards ignoring only `last_seen`, which moves on every write. */
function stripLastSeen(yaml: string): string {
  return yaml
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("last_seen:"))
    .join("\n")
    .trim();
}

/**
 * What the roster needs from the network.
 *
 * Both behavioural dependencies point at domains already extracted —
 * `gitIdentity` at authenticity, `read` at reading — which is the shape to
 * expect as this converges: leaves that call other leaves rather than the whole
 * object.
 */
export interface AgentsContext {
  readonly identity: AgentIdentity;
  /** Read live: a long-lived process picks up joins and leaves. */
  readonly subscriptions: readonly string[];
  readonly repo: Repo;
  readonly recordWorktree: string;
  readonly lockPath: string;
  gitIdentity(): Promise<{ name: string; email: string } | null>;
  read(roomId: string): Promise<Message[]>;
}

export async function publishAgentCard(
  ctx: AgentsContext,
  extras: {
    expertise?: string[];
    speaksFor?: string[];
    presence?: "live" | "away";
    /** Which attached session is arriving or leaving. See `reconcileSessions`. */
    session?: string;
  } = {},
): Promise<boolean> {
  return await FileLock.withLock(ctx.lockPath, async () => {
    const path = agentCardPath(ctx.identity.id);
    const absolute = join(ctx.recordWorktree, path);
    const existing = (await exists(absolute)) ? await readFile(absolute, "utf8") : null;
    let previous: AgentCard | null = null;
    if (existing !== null) {
      try {
        previous = parseAgentCard(existing);
      } catch {
        // Replacing our own malformed card is safer than preserving it.
      }
    }
    const gitAuthor = await ctx.gitIdentity();
    const card = cardFromIdentity(ctx.identity, {
      expertise: extras.expertise ?? previous?.expertise ?? [],
      speaksFor: extras.speaksFor ?? previous?.speaksFor ?? [],
      // Always from live config, never carried over from the old card: a stale
      // list is worse than none, because a sender would act on it.
      subscriptions: [...ctx.subscriptions].sort(),
      ...(gitAuthor === null
        ? previous?.gitAuthor === undefined
          ? {}
          : { gitAuthor: previous.gitAuthor }
        : { gitAuthor }),
    });
    if (previous?.human.workingHours !== undefined) {
      card.human.workingHours = previous.human.workingHours;
    }
    // Reconcile the attached-session set BEFORE deciding the status: with two
    // concurrent sessions, one leaving must not take the agent away with it.
    if (extras.presence === undefined) {
      card.presence.status = previous?.presence.status ?? "away";
      card.presence.sessions = previous?.presence.sessions ?? [];
    } else {
      const reconciled = reconcileSessions(previous?.presence.sessions ?? [], {
        status: extras.presence,
        ...(extras.session === undefined ? {} : { session: extras.session }),
      });
      card.presence.status = reconciled.status;
      card.presence.sessions = reconciled.sessions;
    }
    const next = serializeAgentCard(card);
    // `last_seen` moves on every call, so comparing it would produce a commit
    // per invocation. Everything else — including presence *status* — is
    // compared, so a genuine change does get published.
    if (existing !== null && stripLastSeen(existing) === stripLastSeen(next)) {
      // One exception, and it is the whole point of a live announcement: the
      // stamp IS the evidence readers derive presence from. When the card has
      // aged out of the live window it no longer says what this call is
      // asserting, so the refresh has to land. Bounded by the window itself —
      // announcing twice in a minute still writes once.
      const settled = previous !== null && observedPresenceStatus(previous.presence) === "live";
      if (extras.presence !== "live" || settled) return false;
    }

    await ctx.repo.commitFile(ctx.recordWorktree, path, next, `komnet: agent ${ctx.identity.id}`);
    await ctx.repo.pushWithRetry(ctx.recordWorktree, MAIN_REF, {
      remote: REMOTE,
      // Presence is advisory and frequently contended at the start of a work
      // day. Keep its inline ladder short; a later transition can converge the
      // already-durable local commit without blocking editor startup.
      ...(extras.presence === undefined
        ? {}
        : { maxAttempts: 3, backoffBaseMs: 100, backoffCapMs: 1_000 }),
    });
    return true;
  });
}

export async function listAgents(ctx: AgentsContext): Promise<AgentCard[]> {
  const dir = join(ctx.recordWorktree, "agents");
  if (!(await exists(dir))) return [];
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir, { withFileTypes: true });
  const cards: AgentCard[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    try {
      cards.push(parseAgentCard(await readFile(join(dir, entry.name), "utf8")));
    } catch {
      // A malformed card must not make the roster unreadable.
    }
  }
  return cards.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Publish this agent's cooperative description on `main`. Own file only.
 *
 * The card remains the identity/authenticity record. Profile claims are
 * advisory context for dividing work and never grant authority.
 */
export async function publishAgentProfile(
  ctx: AgentsContext,
  update: AgentProfileUpdate = {},
  runtime?: AgentRuntimeEnvironment,
): Promise<boolean> {
  return await FileLock.withLock(ctx.lockPath, async () => {
    const path = agentProfilePath(ctx.identity.id);
    const absolute = join(ctx.recordWorktree, path);
    const existing = (await exists(absolute)) ? await readFile(absolute, "utf8") : null;
    let previous: AgentProfile | null = null;
    if (existing !== null) {
      try {
        const parsed = parseAgentProfile(existing);
        // A malformed or mis-addressed own file is replaced; it must never let
        // one identity publish another identity's claims.
        if (parsed.id === ctx.identity.id) previous = parsed;
      } catch {
        // Replacing our own malformed profile is safer than preserving it.
      }
    }

    const profile = profileFromIdentity(ctx.identity, previous, update, runtime);
    if (previous !== null && sameAgentProfile(previous, profile)) return false;
    const next = serializeAgentProfile(profile);
    const findings = scanForSecrets(next);
    if (findings.length > 0) throw new SecretDetectedError(findings);

    await ctx.repo.commitFile(ctx.recordWorktree, path, next, `komnet: profile ${ctx.identity.id}`);
    await ctx.repo.pushWithRetry(ctx.recordWorktree, MAIN_REF, {
      remote: REMOTE,
      // Connection-time refresh is advisory and must not hold editor startup
      // behind a long contention ladder. The durable local commit is retried by
      // the record outbox on the next sync.
      ...(runtime === undefined ? {} : { maxAttempts: 3, backoffBaseMs: 100, backoffCapMs: 1_000 }),
    });
    return true;
  });
}

export async function getAgentProfile(
  ctx: AgentsContext,
  agentId: string,
): Promise<AgentProfile | null> {
  const path = join(ctx.recordWorktree, agentProfilePath(agentId));
  if (!(await exists(path))) return null;
  const profile = parseAgentProfile(await readFile(path, "utf8"));
  if (profile.id !== agentId) throw new Error(`agent profile id does not match ${agentId}`);
  return profile;
}

export async function listAgentProfiles(ctx: AgentsContext): Promise<AgentProfile[]> {
  const dir = join(ctx.recordWorktree, "rooms", "komnet", "profiles");
  if (!(await exists(dir))) return [];
  const { readdir } = await import("node:fs/promises");
  const profiles: AgentProfile[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    try {
      const profile = parseAgentProfile(await readFile(join(dir, entry.name), "utf8"));
      if (entry.name === `${profile.id}.md`) profiles.push(profile);
    } catch {
      // One malformed self-description must not make the directory unreadable.
    }
  }
  return profiles.sort((a, b) => a.id.localeCompare(b.id));
}

/** Cards with the scan-friendly role, preserving every existing card field. */
export async function listAgentDirectory(ctx: AgentsContext): Promise<AgentDirectoryEntry[]> {
  const [cards, profiles] = await Promise.all([listAgents(ctx), listAgentProfiles(ctx)]);
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  return cards.map((card) => {
    const profile = profileById.get(card.id);
    return profile === undefined ? card : { ...card, role: profile.role };
  });
}

/**
 * When each agent last wrote to a room this agent subscribes to.
 *
 * Reads the whole live window deliberately. A `limit` would not save any I/O —
 * `read` loads every message file and only then trims — while `threadOrder`
 * groups by thread rather than by time, so trimming can drop a fresh reply that
 * belongs to an old thread. That would report a working agent as stale, which is
 * the exact failure this exists to fix.
 */
async function agentActivity(ctx: AgentsContext): Promise<Map<string, number>> {
  const activity = new Map<string, number>();
  for (const roomId of ctx.subscriptions) {
    let messages: Message[];
    try {
      messages = await ctx.read(roomId);
    } catch {
      // A room whose worktree cannot be opened costs its activity hints, not
      // the whole roster.
      continue;
    }
    for (const message of messages) {
      const at = Date.parse(message.header.ts);
      if (!Number.isFinite(at)) continue;
      const known = activity.get(message.header.from);
      if (known === undefined || at > known) activity.set(message.header.from, at);
    }
  }
  return activity;
}

/**
 * The roster, with presence corrected by observed activity.
 *
 * Both the daemon and the direct backend answer `presence` from here so they
 * cannot drift apart, and so the "live session reads as stale" correction
 * applies wherever presence is asked for.
 */
export async function presenceRoster(ctx: AgentsContext): Promise<PresenceRow[]> {
  const [cards, activity] = await Promise.all([listAgents(ctx), agentActivity(ctx)]);
  return cards.map((card) => {
    const lastActivityAt = activity.get(card.id) ?? null;
    return {
      id: card.id,
      status: observedPresenceWithActivity(card.presence, lastActivityAt),
      lastSeen: card.presence.lastSeen,
      lastActivity: lastActivityAt === null ? null : new Date(lastActivityAt).toISOString(),
      human: card.human.name,
      timezone: card.human.timezone,
      tool: card.tool,
      sessions: liveSessions(card.presence).length,
    };
  });
}

/**
 * One agent as it appears inside a machine, presence and self-description
 * folded together.
 *
 * Wider than `PresenceRow` on purpose: the question this answers is "what is
 * the other session on this box doing, and can I hand it something", which
 * needs the profile's focus and workspace, not just a live/away light.
 */
export interface MachineAgentRow {
  id: string;
  tool: string;
  human: string;
  status: PresenceStatus;
  lastSeen: string;
  lastActivity: string | null;
  sessions: number;
  /** Null when the card publishes no room list (older komnet), never an empty guess. */
  rooms: string[] | null;
  role: string | null;
  focus: string | null;
  /** Safe workspace label from the profile — never an absolute path. */
  workspace: string | null;
}

export interface MachineRow {
  /** Null groups every card written before machine identity existed. */
  id: string | null;
  label: string | null;
  humans: string[];
  /**
   * Several humans claim this one machine id.
   *
   * Almost always two different computers whose hostnames slugify the same way
   * — `macbook-pro` is not a rare name. Reported rather than resolved: nothing
   * on the wire can distinguish "two people share a box" from "two boxes share
   * a name", so the honest move is to surface it and let a person run
   * `komnet machine set`.
   */
  contested: boolean;
  /** Whether this is the machine the reader is running on. */
  self: boolean;
  live: number;
  agents: MachineAgentRow[];
}

async function machineAgentRows(ctx: AgentsContext): Promise<Map<string, MachineAgentRow>> {
  const [cards, profiles, rows] = await Promise.all([
    listAgents(ctx),
    listAgentProfiles(ctx),
    presenceRoster(ctx),
  ]);
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const rowById = new Map(rows.map((row) => [row.id, row]));

  return new Map(
    cards.map((card) => {
      const profile = profileById.get(card.id);
      const row = rowById.get(card.id);
      return [
        card.id,
        {
          id: card.id,
          tool: card.tool,
          human: card.human.name,
          status: row?.status ?? "stale",
          lastSeen: card.presence.lastSeen,
          lastActivity: row?.lastActivity ?? null,
          sessions: liveSessions(card.presence).length,
          rooms: card.subscriptions === undefined ? null : [...card.subscriptions],
          role: profile?.role ?? null,
          focus: profile?.currentFocus ?? null,
          workspace: profile?.environment.workspace ?? null,
        },
      ];
    }),
  );
}

/**
 * The roster grouped by computer rather than by agent id.
 *
 * This is the view that makes routing decidable. A flat list of nine agents
 * hides that they are three machines, so "who can answer about the checkout
 * service" reads as nine strangers instead of one box with three sessions open
 * on it — and the sender picks by name, which is a coin flip.
 *
 * Cards with no machine are kept in their own `id: null` group rather than
 * merged into anything: an older client claimed nothing, and putting it in a
 * group would be inventing the one fact this whole view is about.
 */
export async function machineRoster(ctx: AgentsContext): Promise<MachineRow[]> {
  const cards = await listAgents(ctx);
  const rows = await machineAgentRows(ctx);
  const groups = new Map<string, { id: string | null; label: string | null; ids: string[] }>();

  for (const card of cards) {
    const key = card.machine?.id ?? "";
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        id: card.machine?.id ?? null,
        label: card.machine?.label ?? null,
        ids: [card.id],
      });
    } else {
      group.ids.push(card.id);
    }
  }

  const machines: MachineRow[] = [];
  for (const group of groups.values()) {
    const agents = group.ids
      .map((id) => rows.get(id))
      .filter((row): row is MachineAgentRow => row !== undefined);
    const humans = [...new Set(agents.map((agent) => agent.human))].sort();
    machines.push({
      id: group.id,
      label: group.label,
      humans,
      // An unknown-machine bucket holds unrelated agents by construction, so
      // several humans there is expected rather than a collision to report.
      contested: group.id !== null && humans.length > 1,
      self: group.id !== null && group.id === ctx.identity.machine.id,
      live: agents.filter((agent) => agent.status === "live").length,
      agents: agents.sort((a, b) => a.id.localeCompare(b.id)),
    });
  }

  // This machine first — a reader is nearly always asking about their own box
  // or comparing it with the others — then busiest, then by name.
  return machines.sort((a, b) => {
    if (a.self !== b.self) return a.self ? -1 : 1;
    if (a.live !== b.live) return b.live - a.live;
    return (a.id ?? "\uffff").localeCompare(b.id ?? "\uffff");
  });
}

/**
 * The other agents on this computer.
 *
 * Co-located agents are the ones that can genuinely divide work: they share a
 * filesystem, a checkout, a toolchain and a running service, so handing one of
 * them half a task costs nothing to set up and their claims on a path or a
 * build actually mean something. Finding them used to require knowing their ids
 * in advance, which is the thing a fresh session does not know.
 *
 * Self is excluded — an agent asking who else is here does not mean itself.
 */
export async function localPeers(ctx: AgentsContext): Promise<MachineAgentRow[]> {
  const cards = await listAgents(ctx);
  const rows = await machineAgentRows(ctx);
  return cards
    .filter((card) => card.id !== ctx.identity.id && card.machine?.id === ctx.identity.machine.id)
    .map((card) => rows.get(card.id))
    .filter((row): row is MachineAgentRow => row !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Mentions with every `machine:<id>` token expanded to the agents on it. */
export async function resolveMentions(
  ctx: AgentsContext,
  mentions: readonly string[],
): Promise<string[]> {
  if (!mentions.some((mention) => mention.startsWith(MENTION_MACHINE_PREFIX))) {
    return [...mentions];
  }
  return expandMachineMentions(mentions, await listAgents(ctx));
}
