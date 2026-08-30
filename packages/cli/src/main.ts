import { parseArgs } from "node:util";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  AmbiguousIdentityError,
  ApprovalRequiredError,
  GitRunner,
  IdentityMismatchError,
  isDefaultProfile,
  Layout,
  Network,
  Repo,
  ReviewRepositoryResolver,
  SecretDetectedError,
  describeError,
  loadLocalPolicy,
  policyTemplate,
  defaultIdentity,
  describeFindings,
  emptyConfig,
  loadConfig,
  resolveNetwork,
  saveConfig,
  isGitRemoteName,
  type KomnetConfig,
  type PreparedReviewRepository,
  type ReleasedReviewRepository,
  type Agenda,
  type AgendaCounts,
  type ApprovalRecord,
  type ClaimStatus,
  type Attention,
  type ResumePoint,
  type ReviewTaskStatus,
  type TransportHealth,
  type TaskDetail,
  type TaskStatus,
} from "@komnet/core";
import { DaemonClient, openBackend, type Backend } from "@komnet/daemon";
import {
  REVIEW_TASK_STATES,
  TASK_UPDATE_ACTIONS,
  ulid,
  assertAgentId,
  assertCanonicalRepositoryId,
  assertMachineId,
  assertRoomId,
  isMachineToken,
  isReviewTaskState,
  isTaskUpdateAction,
  machineMention,
  slugify,
  type Message,
} from "@komnet/protocol";

import { conciseGitFailure, sshHostOf } from "./diagnostics.ts";
import {
  daemonEntryProblem,
  daemonInstall,
  daemonStart,
  daemonStatus,
  daemonStop,
} from "./daemon-cmd.ts";
import {
  ago,
  bold,
  cyan,
  dim,
  errline,
  green,
  json,
  messageToJson,
  out,
  red,
  renderAgenda,
  renderInbox,
  renderInboxBrief,
  renderMessages,
  renderTaskDetail,
  yellow,
} from "./output.ts";
import { SETUP_TARGETS, setupTool, type SetupTarget } from "./setup.ts";

export const VERSION = "0.8.0";

const HELP = `komnet ${VERSION} — a message tunnel for AI coding agents over a git repository you own.

USAGE
  komnet <command> [options]

SETUP
  init --repo <url>            clone/adopt a transport repo and register this agent
  setup <tool>                 wire up claude-code | claude-desktop | cursor | codex
                               (--agent <id> pins the tool to its own identity)
  doctor                       diagnose git, config, remote access, worktrees, daemon

AGENTS ON THIS MACHINE
  agent add <id> --repo <url>  provision a second agent with its own KOMNET_HOME
  agent list                   agent identities provisioned here
  agent path <id>              print one agent's KOMNET_HOME
  --agent <id>                 act as this identity, on any command; refuses on mismatch
  machine                      this computer's id, and who else is running on it
  machine set <id>             rename this computer; use when two boxes derived one id
  machine room                 create/join the room the agents on this box share
  peers                        the other agents here: presence, focus, workspace
  machines                     the network grouped by computer instead of by agent id

ROOMS
  room list                    rooms on the network, with unread counts
  room create <id>             create a room (--title, --purpose, --reply-budget)
  room join <id>               subscribe and materialise a room
  room leave <id>              unsubscribe and drop the local worktree
  room show <id>               room configuration

REPOSITORIES
  repo list                    local canonical repository mappings
  repo map <id> <path>         map host/owner/repo to an existing git checkout
  repo unmap <id>              remove a local mapping
  repo policy --max-prepared N cap detached review worktrees on this machine

MESSAGING
  send <room> <text>           send a message
  ask <room> <question>        ask another agent; --needs human parks it for a person
  answer <message-id> <text>   answer a message; --as-human to record a human decision
  decide <room> <title> [body] record a decision; never pruned by sealing
  read <room>                  read the live window (--limit, --thread)
  history <room>               read past the window, from git history (--since)
  search <query>               search the live window of subscribed rooms (--room)
  inbox                        pending messages (--drain, --room, --needs, --tag, --brief)
  trace <message-id>           what became of one message: stored, pushed,
                               and per recipient routable / read / answered
  receipts <room>              who has read what; --reply-to <id> marks who read it
  mentions                     messages naming you in rooms you have not joined

REVIEWS
  review request <room> <text> create a targeted review (--reviewer, --repo, --base, --head)
  review update <room> <id> <state> <text>
                               append a guarded lifecycle transition
  review prepare <room> <id>   resolve and detach the exact local review revision
  review release <id>          remove a prepared review worktree if it is clean
  review approve <room> <id>   record that a person allows this agent to take it
  review list <room>           current review tasks and lifecycle state

TASKS
  task create <room> <text>    create targeted/free work (--title, --target, --stale-after)
  task claim <room> <id> <text> publish that this agent accepts the task
  task update <room> <id> <action> <text>
                               refine or advance a guarded task lifecycle
  task list <room>             assignment, state, stale health, and conflicts
  task show <room> <id>        one task in full — definition, every event, evidence
  task agenda                  unfinished work for this agent across all rooms (--mine)
  task approve <room> <id>     record that a person allows this agent to claim it

SHARED RESOURCES
  claim <room> <resource>      take an advisory, self-expiring lease (--ttl <seconds>)
  claim release <room> <res>   give it back before it expires
  claims <room>                who holds what, and who is waiting

POLICY (machine-local, never published)
  policy                       effective rules and which file they came from
  policy --init                write a commented ~/.komnet/policy.yaml to edit
  approvals                    delegated work a person has approved here

FIRST CONTACT
  handshake <room> [note]      announce this agent live and greet the room
  handshake ack <id> [note]    answer a handshake; confirms the link both ways

CHECKING FOR WORK  (all of these see the remote: the daemon polls, and with no
                    daemon the command pulls for itself before answering)
  status                       counts, and what is worth an interrupt — no bodies
  inbox --brief                one line per pending item; prints NOTHING when idle
  watch --wait <s> --new-only  block for a genuine arrival; exit 3 checked-and-quiet,
                               exit 4 could not check (never mistake one for the other)
  watch --wait <s> --thread <id>   wake when a specific conversation is answered
  watch                        long-lived monitor: one metadata line per item,
                               marked state=new or state=pending
  A shell loop around 'inbox' re-prints every pending item on every pass, which
  costs an agent tokens for news it already has. 'watch' reports each item once.

NETWORKS  (one agent, several transport repos — the daemon polls them all)
  network list                 configured networks; → marks the current one
  network use <id>             switch what a bare command means; running agent
                               sessions pick it up with no restart
  --network <id>               act on one network, for a single command
  --all-networks               'status', 'inbox' and 'watch' cover every one

NETWORK
  sync                         poll the remote and deliver new messages
  seal <room>                  compact a room: merge to main, digest, prune (--check)
  status                       sync freshness, pending counts, subscriptions
  agents                       who is on this network, with short roles
  profile [show] [agent]       role, current work, environment, and cooperation offer
  profile update               update own profile (--role, --mission, --focus, lists)
  presence                     whose agent session is live right now (--live, --away)

DAEMON
  daemon status|start|stop     the background sync process
  daemon install|uninstall     register with launchd / systemd --user
  mcp                          run the MCP server on stdio (editors call this)

OPTIONS
  --json                       machine-readable output (on every read command)
  --network <id>               pick a network when several are configured
  --needs none|agent|human     who must act on this message
  --mention <agent>            route to an agent (repeatable); use @room for everyone
  --machine <id>               route to every agent on one computer (repeatable);
                               on 'task create', offer the work to that whole machine
  --tag <tag>                  tag a message (repeatable)
  --priority low|normal|high|blocking
  --kind msg|question|answer|decision|status|artifact
  --reply-to <message-id>      thread this under an existing message
  --scope <path>               repository-review scope (repeatable)
  --ref <repo@rev:path>        repository-review code reference (repeatable)
  --target <agent>             task target — an agent id or machine:<id>;
                               omit on create for free-to-claim
  --free                       retarget an open task to any room agent
  --stale-after <seconds>      no-event interval before a task is stale (min 60)
  --fetch-remote <name>        allow a mapped local git remote to fetch missing objects
  --force-unsafe <reason>      override a secret-scanner block; the reason is permanent
  --peer <agent>               address a handshake to one agent (repeatable)
  --role <text>                profile: one-line capabilities/responsibility summary
  --mission <text>             profile: human goal this agent advances
  --focus <text>               profile: what this agent is doing now
  --workspace <label>          profile: safe label/canonical repo, never a local path
  --capability <text>          profile capability (repeatable)
  --responsibility <text>      profile responsibility (repeatable)
  --constraint <text>          profile limitation (repeatable)
  --help-with <text>           profile cooperation offer (repeatable)
  --interval <seconds>         'watch': poll cadence (default 15, min 2)
  --once                       'watch': emit what is pending, then exit
  --wait <seconds>             'watch': block until one match arrives
                               exit 3: checked, nothing came. exit 4: could NOT check
  --new-only                   'watch': ignore the existing backlog; wake on arrivals
  --room/--thread/--tag/--needs  'watch': narrow it — e.g. --thread <id> for one answer
  --direct                     bypass the daemon and open the network in-process
  --version, --help

NOTES
  Everything you send is permanent and visible to everyone with repo access.
  'needs: human' is a cooperative workflow signal. Direct agent/MCP answers are
  refused, but --as-human attribution is not strict proof of human presence.
  Commands run through the daemon when it is up, and directly otherwise — in
  which case each one pulls once before answering, so a read is never a report
  about a network nobody has looked at.
`;

interface Ctx {
  layout: Layout;
  config: KomnetConfig;
  values: Record<string, unknown>;
  positionals: string[];
}

function str(ctx: Ctx, key: string): string | undefined {
  const v = ctx.values[key];
  return typeof v === "string" ? v : undefined;
}

function num(ctx: Ctx, key: string): number | undefined {
  const raw = str(ctx, key);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) usage(`--${key} must be a number`);
  return parsed;
}

function bool(ctx: Ctx, key: string): boolean {
  return ctx.values[key] === true;
}

function list(ctx: Ctx, key: string): string[] {
  const v = ctx.values[key];
  return Array.isArray(v) ? (v as string[]) : [];
}

class UsageError extends Error {}

function usage(message: string): never {
  errline(red(`error: ${message}`));
  errline("");
  errline("Run 'komnet --help' for usage.");
  throw new UsageError(message);
}

async function loadOrEmpty(layout: Layout): Promise<KomnetConfig> {
  return (await loadConfig(layout.configPath)) ?? emptyConfig(defaultIdentity());
}

/**
 * Run against the daemon when one is listening, and directly otherwise.
 *
 * Preferring the daemon keeps inbox state single-writer and lets presence stay
 * accurate; direct mode means a stopped daemon never blocks a human (ADR 0005).
 *
 * A command is NOT a session by default. Only a command that keeps running —
 * `watch` — passes `session`, because the daemon publishes a presence
 * transition per session, and a one-shot command that declared one wrote `live`
 * and then `away` on `main` for every invocation.
 */
async function withBackend(
  ctx: Ctx,
  fn: (backend: Backend) => Promise<number>,
  options: { session?: boolean } = {},
): Promise<number> {
  const network = str(ctx, "network");
  const backend = await openBackend({
    layout: ctx.layout,
    ...(network === undefined ? {} : { network }),
    ...(bool(ctx, "direct") ? { forceDirect: true } : {}),
    ...(options.session === undefined ? {} : { session: options.session }),
  });
  try {
    return await fn(backend);
  } finally {
    await backend.close();
  }
}

// `init` and `doctor` deliberately bypass `withBackend`: init runs before any
// network exists, and doctor must inspect the real local state rather than
// whatever a daemon reports about it.

// ------------------------------------------------------------------ commands

/**
 * Commands that write a permanently attributed message.
 *
 * The gate applies to these and not to reads. Reading as the wrong agent shows
 * a confusing inbox and can be corrected by looking again; writing as the wrong
 * agent puts someone else's name on a message the whole team can read, forever.
 */
const ATTRIBUTING_COMMANDS = new Set([
  "send",
  "ask",
  "answer",
  "decide",
  "task",
  "review",
  "claim",
  "handshake",
]);

/** Commands that create or point at identities, so they must not be re-homed. */
const IDENTITY_NEUTRAL_COMMANDS = new Set(["init", "agent", "setup", "mcp", "daemon", "doctor"]);

/** Agent ids provisioned on this machine, each with its own KOMNET_HOME. */
async function provisionedAgents(root: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  try {
    const entries = await readdir(join(root, "agents"), { withFileTypes: true });
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await pathExists(join(root, "agents", entry.name, "config.yaml"))) ids.push(entry.name);
    }
    return ids.sort();
  } catch {
    return [];
  }
}

/**
 * Decide which identity this invocation acts as, and refuse if it is a guess.
 *
 * Two failures, both seen in practice. An agent shells out to `komnet` from a
 * terminal whose environment does not carry its `KOMNET_HOME`, and the message
 * lands under whichever identity the default home happens to hold. Or a tool
 * believes it is pinned to one identity and is not. Both produce a permanent,
 * misattributed message, and the only repair is a second message admitting it.
 *
 * `--agent <id>` (or `KOMNET_AGENT`) both SELECTS that agent's home and ASSERTS
 * the result, so it cannot silently resolve to somebody else.
 */
async function resolveIdentity(
  ctx: Ctx,
  command: string,
): Promise<{ layout: Layout; config: KomnetConfig }> {
  const asserted = str(ctx, "agent") ?? process.env["KOMNET_AGENT"];
  const homeIsExplicit = process.env["KOMNET_HOME"] !== undefined;

  if (asserted !== undefined && asserted !== "") {
    assertAgentId(asserted);
    // Prefer that agent's own home when one is provisioned, so the assertion is
    // a way to act AS them rather than only a way to fail.
    const home = ctx.layout.agentHomeDir(asserted);
    if (await pathExists(join(home, "config.yaml"))) {
      const layout = new Layout(home);
      const config = await loadOrEmpty(layout);
      if (config.agent.id !== asserted) {
        throw new IdentityMismatchError(asserted, config.agent.id, home);
      }
      return { layout, config };
    }
    if (ctx.config.agent.id !== asserted) {
      throw new IdentityMismatchError(asserted, ctx.config.agent.id, ctx.layout.root);
    }
    return { layout: ctx.layout, config: ctx.config };
  }

  if (!homeIsExplicit && ATTRIBUTING_COMMANDS.has(command)) {
    const candidates = await provisionedAgents(ctx.layout.root);
    if (candidates.length > 0) {
      throw new AmbiguousIdentityError(command, ctx.config.agent.id, candidates);
    }
  }
  return { layout: ctx.layout, config: ctx.config };
}

async function cmdInit(ctx: Ctx): Promise<number> {
  const remote = str(ctx, "repo") ?? ctx.positionals[1];
  if (remote === undefined) usage("init needs a repository: komnet init --repo <url>");

  const networkId =
    str(ctx, "network") ??
    slugify(
      remote
        .replace(/\.git$/, "")
        .split(/[/:]/)
        .pop() ?? "komnet",
    ) ??
    "komnet";

  const agentId = str(ctx, "agent");
  if (agentId !== undefined) {
    assertAgentId(agentId);
    ctx.config.agent = defaultIdentity({ id: agentId });
  }

  out(`Connecting to ${bold(remote)} as ${bold(ctx.config.agent.id)}…`);
  const { network, createdNetwork } = await Network.init({
    layout: ctx.layout,
    networkId,
    remote,
    identity: ctx.config.agent,
  });

  try {
    ctx.config.networks[networkId] = network.config;
    ctx.config.defaultNetwork ??= networkId;
    await saveConfig(ctx.layout.configPath, ctx.config);

    const rooms = await network.listRooms().catch(() => []);
    out(green(createdNetwork ? "✓ initialised a new network" : "✓ joined existing network"));
    // "joined existing network" next to "no rooms yet" reads like a failed
    // sync. Say which it is: an empty network is a fact about the network, not
    // a symptom.
    if (!createdNetwork) {
      out(
        rooms.length === 0
          ? dim("  it exists but is empty — nobody has created a room yet")
          : dim(`  ${String(rooms.length)} room(s) already here — komnet room list`),
      );
    }
    out(`✓ agent card published as ${ctx.config.agent.id}`);
    out(`✓ config written to ${ctx.layout.configPath}`);
    // Adding a network does not switch to it — silently moving what every bare
    // command means is worse than saying so. But NOT saying so is how the next
    // `komnet room create` lands on the old network and looks like a bug.
    if (ctx.config.defaultNetwork !== networkId) {
      out();
      out(
        yellow(`! commands still act on ${bold(ctx.config.defaultNetwork ?? "?")}`) +
          dim(` — this added ${networkId} without switching`),
      );
      out(`  ${cyan(`komnet network use ${networkId}`)}${dim("   · or --network on one command")}`);
    }
    out();
    // The card is published blank, and a blank card is the reason "who owns
    // auth?" gets no answer on a fresh network. Asking for it here — at the one
    // moment the user is already configuring — is what stops a directory of
    // empty entries from being the default state.
    out(bold("Say what you cover, or peers cannot route work to you:"));
    out(
      `  ${cyan(`komnet profile update --role '<what you do>' --responsibility '<repo you own>'`)}`,
    );
    out();
    out(
      `Next:  ${cyan("komnet room list")}   ${dim("·")}   ${cyan("komnet daemon start")}   ${dim("·")}   ${cyan("komnet setup claude-code")}`,
    );
    out(
      dim(
        `Someone may have written to you before you joined a room: ${"komnet mentions"} finds it.`,
      ),
    );
    return 0;
  } finally {
    network.close();
  }
}

async function cmdRoom(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1] ?? "list";
  const roomId = ctx.positionals[2];

  return await withBackend(ctx, async (be) => {
    switch (sub) {
      case "list": {
        const rooms =
          await be.call<{ id: string; title: string; subscribed: boolean; pending: number }[]>(
            "rooms",
          );
        if (bool(ctx, "json")) {
          json(rooms);
          return 0;
        }
        if (rooms.length === 0) {
          out(dim("no rooms yet — create one: komnet room create <name>"));
          return 0;
        }
        for (const r of rooms) {
          const mark = r.subscribed ? green("●") : dim("○");
          const pending = r.pending > 0 ? yellow(` ${String(r.pending)} pending`) : "";
          out(`${mark} ${bold(r.id.padEnd(20))} ${dim(r.title)}${pending}`);
        }
        return 0;
      }
      case "create": {
        if (roomId === undefined) usage("room create needs a name");
        assertRoomId(roomId);
        const title = str(ctx, "title");
        const purpose = str(ctx, "purpose");
        // Settable only at creation: room.yaml is shared, and an agent may
        // rewrite only its own card, profile, and receipts (ADR 0004).
        const replyBudget = num(ctx, "reply-budget");
        await be.call("roomCreate", {
          room: roomId,
          ...(title === undefined ? {} : { title }),
          ...(purpose === undefined ? {} : { purpose }),
          ...(replyBudget === undefined ? {} : { replyBudget }),
        });
        out(green(`✓ created room ${roomId} and subscribed`));
        if (replyBudget !== undefined) {
          out(dim(`  reply budget ${String(replyBudget)} — threads park for a person after that`));
        }
        return 0;
      }
      case "join": {
        if (roomId === undefined) usage("room join needs a name");
        await be.call("roomJoin", { room: assertRoomId(roomId) });
        out(green(`✓ joined ${roomId}`));
        return 0;
      }
      case "leave": {
        if (roomId === undefined) usage("room leave needs a name");
        await be.call("roomLeave", { room: assertRoomId(roomId) });
        out(green(`✓ left ${roomId}`));
        return 0;
      }
      case "show": {
        if (roomId === undefined) usage("room show needs a name");
        const room = await be.call<{
          id: string;
          title: string;
          purpose: string;
          status: string;
          created: string;
          createdBy: string;
          retention: { windowDays: number; windowMessages: number };
        } | null>("roomShow", { room: assertRoomId(roomId) });
        if (room === null) {
          errline(red(`no such room: ${roomId}`));
          return 1;
        }
        if (bool(ctx, "json")) json(room);
        else {
          out(`${bold(room.title)} ${dim(`(${room.id})`)}`);
          if (room.purpose !== "") out(room.purpose);
          out(dim(`status ${room.status} · created ${ago(room.created)} by ${room.createdBy}`));
          out(
            dim(
              `window ${String(room.retention.windowDays)}d / ${String(room.retention.windowMessages)} msgs`,
            ),
          );
        }
        return 0;
      }
      default:
        usage(`unknown 'room' subcommand: ${sub}`);
    }
  });
}

/**
 * Warn when a mention will not reach the agent it names.
 *
 * Printed after the send rather than blocking it: the forecast is a hint, the
 * peer may have joined a moment ago, and refusing would be worse than a silent
 * miss. But the miss must be visible — an unanswered question whose recipient
 * never followed the room reads exactly like being ignored.
 */
async function warnUndeliverable(
  be: Backend,
  room: string,
  mentions: readonly string[],
): Promise<void> {
  if (mentions.length === 0) return;
  const forecast = await be
    .call<{ agent: string; outlook: string; reason: string }[]>("forecastDelivery", {
      room,
      agents: mentions,
    })
    .catch(() => []);
  for (const entry of forecast) {
    if (entry.outlook === "misses") {
      errline(yellow(`! ${entry.agent} ${entry.reason}`));
      errline(dim(`  ask them to run: komnet room join ${room}`));
    } else if (entry.outlook === "unknown") {
      errline(dim(`? ${entry.agent}: ${entry.reason}`));
    }
  }
}

/** A room holding commits the remote has not seen. See `Network.outbox`. */
interface OutboxRow {
  roomId: string;
  ahead: number;
  since: string | null;
  reason: string | null;
}

/** Whether this room still holds unpushed commits, and why. */
async function queuedIn(be: Backend, room: string): Promise<OutboxRow | null> {
  const rows = await be.call<OutboxRow[]>("outbox").catch(() => []);
  return rows.find((row) => row.roomId === room) ?? null;
}

/**
 * Say which of the two states a write actually reached.
 *
 * A message is committed to the room branch before it is pushed, so a failed
 * push leaves it **written and safe**, going out on the next sync. komnet used
 * to report that as a hard error carrying raw git plumbing — and a sender who
 * believes "your message failed" sends it again, into a log where the duplicate
 * is permanent. The distinction is the whole point: `sent` means the remote has
 * it; `queued` means this machine does, and will keep trying.
 */
function reportDelivery(id: string, queued: OutboxRow | null): void {
  if (queued === null) {
    out(green("✓ sent") + dim(` ${id}`));
    return;
  }
  out(yellow("⧗ queued") + dim(` ${id}`) + " — written here, not yet on the remote");
  if (queued.reason !== null) out(dim(`  remote said: ${queued.reason}`));
  out(dim("  it goes out on the next sync; retry now with: komnet sync"));
  out(dim("  do NOT send it again — the message is safe, and a duplicate is permanent"));
}

async function cmdSend(ctx: Ctx, asQuestion: boolean): Promise<number> {
  const roomId = ctx.positionals[1];
  const body = ctx.positionals.slice(2).join(" ");
  if (roomId === undefined || body === "") {
    usage(asQuestion ? "ask needs a room and a question" : "send needs a room and a message");
  }
  assertRoomId(roomId);

  // `ask` defaults to `agent`, not `human`.
  //
  // Parking on a person by default made `needs: human` the ordinary case, and a
  // marker that fires by default stops carrying information: an inbox where most
  // items claim to need a decision is one nobody can triage. Most questions
  // between agents are answerable from a repository by the agent that owns it.
  // Escalating is now the deliberate act, with `--needs human`.
  const needs = str(ctx, "needs") ?? (asQuestion ? "agent" : "none");
  const kind = str(ctx, "kind") ?? (asQuestion ? "question" : "msg");
  // `--machine <id>` addresses a computer rather than one agent on it. It is a
  // mention like any other once expanded, so it composes with `--mention`.
  const mentions = [
    ...list(ctx, "mention"),
    ...list(ctx, "machine").map((id) => machineMention(assertMachineId(id))),
  ];
  const tags = list(ctx, "tag");
  const priority = str(ctx, "priority");
  const replyTo = str(ctx, "reply-to");
  const forceUnsafe = str(ctx, "force-unsafe");

  return await withBackend(ctx, async (be) => {
    const message = await be.call<Message>("send", {
      room: roomId,
      input: {
        body,
        kind,
        needs,
        ...(mentions.length > 0 ? { mentions } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(priority === undefined ? {} : { priority }),
        ...(replyTo === undefined ? {} : { inReplyTo: replyTo }),
        ...(forceUnsafe === undefined ? {} : { forceUnsafe }),
      },
    });
    const queued = await queuedIn(be, roomId);
    if (bool(ctx, "json")) {
      json({ ...messageToJson(message), delivery: queued === null ? "pushed" : "queued" });
      return 0;
    }
    reportDelivery(message.header.id, queued);
    await warnUndeliverable(be, roomId, message.header.mentions);
    if (message.header.needs === "human") {
      out(dim("  parked — surface this to a human; relay attribution is cooperative."));
    }
    if (message.header.tags.includes("reply-budget")) out(replyBudgetHint(message.header.thread));
    return 0;
  });
}

/**
 * Prompt before recording an answer as relayed from a human.
 *
 * Requiring a TTY prevents accidental non-interactive use. It does not prove a
 * person supplied the input; shell-capable agents can also control terminals.
 */
async function confirmAtTerminal(request: {
  room: string;
  from: string;
  question: string;
  answer: string;
}): Promise<boolean> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    errline(
      red("✗ --as-human needs an interactive terminal.") +
        "\n  This best-effort check prevents accidental non-interactive attribution;" +
        "\n  it does not authenticate a human. Run the relay from a terminal.",
    );
    return false;
  }

  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    out("");
    out(bold("Recording this as a HUMAN-RELAYED decision permanently:"));
    out(dim(`  room     #${request.room}`));
    out(dim(`  asked by ${request.from}`));
    out(`  ${dim("Q:")} ${request.question.trim().split("\n")[0] ?? ""}`);
    out(`  ${dim("A:")} ${request.answer.trim().split("\n")[0] ?? ""}`);
    out("");
    const reply = await rl.question(`${yellow("Confirm this human-relayed decision?")} [y/N] `);
    return /^y(es)?$/i.test(reply.trim());
  } finally {
    rl.close();
  }
}

/**
 * Promote a settled outcome to the permanent record.
 *
 * This existed over MCP and in the design document's CLI surface, but not in
 * the CLI itself — so a shell-driven agent could hold the whole discussion and
 * then have no way to record what it concluded. That gap matters more than a
 * missing convenience: sealing prunes ordinary messages out of the live window
 * and decisions are what it never prunes, so an unrecorded outcome is one that
 * disappears at the next compaction.
 */
async function cmdDecide(ctx: Ctx): Promise<number> {
  const roomId = ctx.positionals[1];
  const title = ctx.positionals[2];
  const body = ctx.positionals.slice(3).join(" ");
  if (roomId === undefined || title === undefined) {
    usage('decide needs a room and a title: komnet decide <room> "<title>" "<what was decided>"');
  }
  assertRoomId(roomId);

  const supersedes = str(ctx, "reply-to");
  return await withBackend(ctx, async (be) => {
    const message = await be.call<Message>("send", {
      room: roomId,
      input: {
        body: body === "" ? title : `${title}\n\n${body}`,
        kind: "decision",
        needs: "none",
        ...(supersedes === undefined ? {} : { inReplyTo: supersedes }),
      },
    });
    if (bool(ctx, "json")) {
      json(messageToJson(message));
      return 0;
    }
    const queued = await queuedIn(be, roomId);
    if (queued === null) out(green("✓ decision recorded") + dim(` ${message.header.id}`));
    else reportDelivery(message.header.id, queued);
    out(dim("  decisions are never pruned by sealing — this outlives the live window"));
    return 0;
  });
}

async function cmdAnswer(ctx: Ctx): Promise<number> {
  const messageId = ctx.positionals[1];
  const body = ctx.positionals.slice(2).join(" ");
  if (messageId === undefined || body === "") usage("answer needs a message id and a reply");

  // `--as-human` runs DIRECT, never through the daemon: the confirmation needs
  // this process's terminal, and a socket has no human on the other end.
  if (bool(ctx, "as-human")) {
    const netConfig = resolveNetwork(ctx.config, str(ctx, "network"));
    const network = Network.open(ctx.layout, netConfig, ctx.config.agent);
    try {
      const message = await network.answer(messageId, body, {
        confirmHuman: (request) => confirmAtTerminal(request),
      });
      if (bool(ctx, "json")) json(messageToJson(message));
      else out(green("✓ recorded as a human-relayed decision") + dim(` ${message.header.id}`));
      return 0;
    } finally {
      network.close();
    }
  }

  return await withBackend(ctx, async (be) => {
    const message = await be.call<Message>("answer", { messageId, body });
    const queued = await queuedIn(be, message.header.room);
    if (bool(ctx, "json")) {
      json({ ...messageToJson(message), delivery: queued === null ? "pushed" : "queued" });
      return 0;
    }
    if (queued === null) out(green("✓ answered") + dim(` ${message.header.id}`));
    else reportDelivery(message.header.id, queued);
    return 0;
  });
}

async function cmdRepo(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1] ?? "list";

  switch (sub) {
    case "list": {
      const mappings = Object.entries(ctx.config.repositories).map(([id, mapping]) => ({
        id,
        ...mapping,
      }));
      if (bool(ctx, "json")) {
        json({ repositories: mappings, review: ctx.config.review });
        return 0;
      }
      if (mappings.length === 0) {
        out(dim("no local repository mappings — add one: komnet repo map <id> <path>"));
      } else {
        for (const mapping of mappings) {
          out(
            `${bold(mapping.id)}  ${mapping.path}${
              mapping.fetchRemote === undefined
                ? dim(" · fetch disabled")
                : dim(` · fetch ${mapping.fetchRemote}`)
            }`,
          );
        }
      }
      out(dim(`prepared worktree limit ${String(ctx.config.review.maxPreparedWorktrees)}`));
      return 0;
    }
    case "map": {
      const id = ctx.positionals[2];
      const inputPath = ctx.positionals[3];
      if (id === undefined || inputPath === undefined) {
        usage("repo map needs <host/owner/repo> <existing-checkout-path>");
      }
      assertCanonicalRepositoryId(id);
      const fetchRemote = str(ctx, "fetch-remote");
      if (fetchRemote !== undefined && !isGitRemoteName(fetchRemote)) {
        usage("--fetch-remote must be a safe local git remote name");
      }
      const mapping = {
        path: await realpath(inputPath),
        ...(fetchRemote === undefined ? {} : { fetchRemote }),
      };
      await new ReviewRepositoryResolver(ctx.layout, ctx.config).inspectMapping(id, mapping);
      ctx.config.repositories[id] = mapping;
      await saveConfig(ctx.layout.configPath, ctx.config);
      if (bool(ctx, "json")) json({ id, ...mapping });
      else {
        out(green(`✓ mapped ${id}`) + dim(` → ${mapping.path}`));
        out(
          mapping.fetchRemote === undefined
            ? dim("  missing objects will not be fetched")
            : dim(`  missing objects may be fetched from local remote ${mapping.fetchRemote}`),
        );
      }
      return 0;
    }
    case "unmap": {
      const id = ctx.positionals[2];
      if (id === undefined) usage("repo unmap needs <host/owner/repo>");
      assertCanonicalRepositoryId(id);
      const existed = ctx.config.repositories[id] !== undefined;
      delete ctx.config.repositories[id];
      if (existed) await saveConfig(ctx.layout.configPath, ctx.config);
      if (bool(ctx, "json")) json({ id, removed: existed });
      else out(existed ? green(`✓ unmapped ${id}`) : dim(`no mapping for ${id}`));
      return 0;
    }
    case "policy": {
      const raw = str(ctx, "max-prepared");
      if (raw === undefined) usage("repo policy needs --max-prepared <1..32>");
      const maxPreparedWorktrees = Number(raw);
      if (
        !Number.isInteger(maxPreparedWorktrees) ||
        maxPreparedWorktrees < 1 ||
        maxPreparedWorktrees > 32
      ) {
        usage("--max-prepared must be an integer from 1 to 32");
      }
      ctx.config.review.maxPreparedWorktrees = maxPreparedWorktrees;
      await saveConfig(ctx.layout.configPath, ctx.config);
      if (bool(ctx, "json")) json(ctx.config.review);
      else out(green(`✓ prepared review worktree limit ${String(maxPreparedWorktrees)}`));
      return 0;
    }
    default:
      usage("unknown repo subcommand; use repo list, map, unmap, or policy");
  }
}

async function cmdReview(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1];
  if (sub === undefined) {
    usage("review needs a subcommand: request, update, prepare, release, approve, or list");
  }

  if (sub === "approve") return await cmdApprove(ctx, "review");

  if (sub === "release") {
    const reviewId = ctx.positionals[2];
    if (reviewId === undefined) usage("review release needs <review-id>");
    return await withBackend(ctx, async (be) => {
      const released = await be.call<ReleasedReviewRepository>("reviewRelease", { reviewId });
      if (bool(ctx, "json")) json(released);
      else if (released.released) out(green(`✓ released review ${reviewId}`));
      else out(dim(`review ${reviewId} has no prepared worktree`));
      return 0;
    });
  }

  const room = ctx.positionals[2];
  if (room === undefined) {
    usage("review needs a room: review request|update|prepare|list <room>");
  }
  assertRoomId(room);

  return await withBackend(ctx, async (be) => {
    switch (sub) {
      case "request": {
        const reviewer = str(ctx, "reviewer");
        const repo = str(ctx, "repo");
        const baseRev = str(ctx, "base");
        const headRev = str(ctx, "head");
        const summary = ctx.positionals.slice(3).join(" ");
        if (
          reviewer === undefined ||
          repo === undefined ||
          baseRev === undefined ||
          headRev === undefined ||
          summary === ""
        ) {
          usage(
            "review request needs text plus --reviewer <agent> --repo <host/owner/repo> --base <sha> --head <sha>",
          );
        }
        assertAgentId(reviewer);
        const deadline = str(ctx, "deadline");
        const message = await be.call<Message>("reviewRequest", {
          room,
          input: {
            reviewer,
            repo,
            baseRev,
            headRev,
            summary,
            ...(list(ctx, "scope").length === 0 ? {} : { scope: list(ctx, "scope") }),
            ...(deadline === undefined ? {} : { deadline }),
          },
        });
        if (bool(ctx, "json")) json(messageToJson(message));
        else {
          out(green("✓ review requested") + dim(` ${message.header.review?.id ?? ""}`));
          out(dim(`  ${repo}@${headRev.slice(0, 12)} → ${reviewer}`));
        }
        return 0;
      }
      case "update": {
        const reviewId = ctx.positionals[3];
        const state = ctx.positionals[4];
        const body = ctx.positionals.slice(5).join(" ");
        if (reviewId === undefined || !isReviewTaskState(state) || body === "") {
          usage(
            `review update needs <review-id> <state> <text>; state is one of: ${REVIEW_TASK_STATES.join(", ")}`,
          );
        }
        const message = await be.call<Message>("reviewUpdate", {
          room,
          reviewId,
          input: {
            state,
            body,
            ...(list(ctx, "ref").length === 0 ? {} : { refs: list(ctx, "ref") }),
          },
        });
        if (bool(ctx, "json")) json(messageToJson(message));
        else out(green(`✓ review ${reviewId} → ${state}`) + dim(` ${message.header.id}`));
        return 0;
      }
      case "prepare": {
        const reviewId = ctx.positionals[3];
        if (reviewId === undefined) usage("review prepare needs <room> <review-id>");
        const prepared = await be.call<PreparedReviewRepository>("reviewPrepare", {
          room,
          reviewId,
        });
        if (bool(ctx, "json")) json(prepared);
        else {
          out(
            green(
              prepared.reused ? "✓ review worktree already prepared" : "✓ review worktree prepared",
            ) + dim(` ${prepared.reviewId}`),
          );
          out(`  checkout ${prepared.checkoutPath}`);
          out(`  target   ${prepared.headRev}`);
          out(`  relation ${prepared.relation}`);
          if (prepared.scope.length > 0) out(`  scope    ${prepared.scope.join(", ")}`);
        }
        return 0;
      }
      case "list": {
        const reviews = await be.call<ReviewTaskStatus[]>("reviews", { room });
        if (bool(ctx, "json")) {
          json(reviews);
          return 0;
        }
        if (reviews.length === 0) {
          out(dim(`no review tasks in ${room}`));
          return 0;
        }
        for (const status of reviews) {
          const r = status.review;
          const conflicts =
            status.invalidEvents.length === 0
              ? ""
              : red(` · ${String(status.invalidEvents.length)} invalid event(s)`);
          out(
            `${bold(r.id)}  ${cyan(r.state.padEnd(11))} ${r.repo}@${r.headRev.slice(0, 12)} → ${r.reviewer}${conflicts}`,
          );
        }
        return 0;
      }
      default:
        usage("unknown review subcommand; use request, update, prepare, release, approve, or list");
    }
  });
}

/**
 * The `--target` / `--machine` pair, resolved to one task target.
 *
 * `--machine <id>` is sugar for `--target machine:<id>` and exists because the
 * token form is the sort of thing a person gets subtly wrong once and then
 * cannot see. Both at once is refused rather than ranked: silently preferring
 * one would hand the work to a party the caller did not name.
 */
function taskTarget(ctx: Ctx): string | undefined {
  const target = str(ctx, "target");
  const machines = list(ctx, "machine");
  if (target !== undefined && machines.length > 0) {
    usage("use either --target or --machine, not both");
  }
  if (machines.length > 1) usage("a task can be offered to one machine, not several");
  const machine = machines[0];
  if (machine !== undefined) return machineMention(assertMachineId(machine));
  if (target === undefined) return undefined;
  if (isMachineToken(target)) return target;
  return assertAgentId(target);
}

async function cmdTask(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1];
  if (sub === undefined) {
    usage("task needs a subcommand: create, claim, update, show, list, or agenda");
  }

  // Agenda spans every subscribed room, so it takes no room argument — it is
  // the answer to "what am I on the hook for", not "what is in this room".
  if (sub === "agenda") return await cmdAgenda(ctx);
  if (sub === "approve") return await cmdApprove(ctx, "task");

  const room = ctx.positionals[2];
  if (room === undefined) usage("task needs a room: task create|claim|update|show|list <room>");
  assertRoomId(room);

  return await withBackend(ctx, async (be) => {
    switch (sub) {
      case "create": {
        const definition = ctx.positionals.slice(3).join(" ");
        const title = str(ctx, "title");
        if (title === undefined || definition === "") {
          usage("task create needs <room> <text> --title <one-line title>");
        }
        const target = taskTarget(ctx);
        const staleAfterSeconds = num(ctx, "stale-after");
        if (
          staleAfterSeconds !== undefined &&
          (!Number.isInteger(staleAfterSeconds) ||
            staleAfterSeconds < 60 ||
            staleAfterSeconds > 365 * 24 * 60 * 60)
        ) {
          usage("--stale-after must be an integer from 60 to 31536000 seconds");
        }
        const priority = str(ctx, "priority");
        const message = await be.call<Message>("taskCreate", {
          room,
          input: {
            title,
            definition,
            ...(target === undefined ? {} : { target }),
            ...(staleAfterSeconds === undefined ? {} : { staleAfterSeconds }),
            ...(priority === undefined ? {} : { priority }),
          },
        });
        if (bool(ctx, "json")) json(messageToJson(message));
        else {
          out(green("✓ task created") + dim(` ${message.header.task?.id ?? ""}`));
          out(
            dim(
              `  ${
                target === undefined
                  ? "free to claim"
                  : isMachineToken(target)
                    ? `offered to every agent on ${target.slice("machine:".length)}`
                    : `target → ${target}`
              }`,
            ),
          );
        }
        return 0;
      }
      case "claim": {
        const taskId = ctx.positionals[3];
        const body = ctx.positionals.slice(4).join(" ");
        if (taskId === undefined || body === "") {
          usage("task claim needs <room> <task-id> <what you are taking and first step>");
        }
        const message = await be.call<Message>("taskClaim", { room, taskId, body });
        if (bool(ctx, "json")) json(messageToJson(message));
        else out(green(`✓ task ${taskId} claimed`) + dim(` ${message.header.id}`));
        return 0;
      }
      case "update": {
        const taskId = ctx.positionals[3];
        const action = ctx.positionals[4];
        const body = ctx.positionals.slice(5).join(" ");
        if (taskId === undefined || !isTaskUpdateAction(action) || body === "") {
          usage(
            `task update needs <room> <task-id> <action> <text>; action is one of: ${TASK_UPDATE_ACTIONS.join(", ")}`,
          );
        }
        const target = taskTarget(ctx);
        if (target !== undefined && bool(ctx, "free"))
          usage("use either --target or --free, not both");
        const needs = str(ctx, "needs");
        if (needs !== undefined && needs !== "human") {
          usage("task update accepts only --needs human; omit it for agent-owned progress");
        }
        const title = str(ctx, "title");
        const refs = list(ctx, "ref");
        const message = await be.call<Message>("taskUpdate", {
          room,
          taskId,
          input: {
            action,
            body,
            ...(refs.length === 0 ? {} : { refs }),
            ...(title === undefined ? {} : { title }),
            ...(target === undefined && !bool(ctx, "free")
              ? {}
              : { target: bool(ctx, "free") ? null : target }),
            ...(needs === "human" ? { needsHuman: true } : {}),
          },
        });
        if (bool(ctx, "json")) json(messageToJson(message));
        else {
          const state = message.header.task?.state ?? "unknown";
          out(green(`✓ task ${taskId} → ${state}`) + dim(` ${message.header.id}`));
          if (message.header.needs === "human") {
            out(dim("  parked for a critical human decision; attribution remains cooperative."));
          }
        }
        return 0;
      }
      case "show": {
        const taskId = ctx.positionals[3];
        if (taskId === undefined) usage("task show needs <room> <task-id>");
        const detail = await be.call<TaskDetail>("taskShow", { room, taskId });
        if (bool(ctx, "json")) json(detail);
        else renderTaskDetail(detail);
        return 0;
      }
      case "list": {
        const tasks = await be.call<TaskStatus[]>("tasks", { room });
        if (bool(ctx, "json")) {
          json(tasks);
          return 0;
        }
        if (tasks.length === 0) {
          out(dim(`no tasks in ${room}`));
          return 0;
        }
        for (const status of tasks) {
          const task = status.task;
          const state = status.stale ? `stale/${task.state}` : task.state;
          const owner = task.assignee ?? task.target ?? "any agent";
          const conflicts =
            status.invalidEvents.length === 0
              ? ""
              : red(` · ${String(status.invalidEvents.length)} invalid event(s)`);
          out(
            `${bold(task.id)}  ${status.stale ? yellow(state.padEnd(20)) : cyan(state.padEnd(20))} ${task.title} → ${owner} · ${ago(status.updatedAt)}${conflicts}`,
          );
        }
        return 0;
      }
      default:
        usage("unknown task subcommand; use create, claim, update, show, list, or agenda");
    }
  });
}

/**
 * Record that a person approved this agent taking on delegated work.
 *
 * CLI only, and deliberately absent from the MCP tool surface: an agent able to
 * approve its own inbound work is a gate that gates nothing. Same reasoning as
 * the `--as-human` relay in ADR 0012 — this asserts a person agreed, it does
 * not prove one did, and the assertion is at least made at a terminal.
 */
async function cmdApprove(ctx: Ctx, kind: "task" | "review"): Promise<number> {
  const room = ctx.positionals[2];
  const id = ctx.positionals[3];
  if (room === undefined || id === undefined) {
    usage(`${kind} approve needs <room> <${kind}-id> [note]`);
  }
  assertRoomId(room);
  const note = ctx.positionals.slice(4).join(" ");

  return await withBackend(ctx, async (be) => {
    if (bool(ctx, "revoke")) {
      const { revoked } = await be.call<{ revoked: boolean }>("approveRevoke", { kind, id });
      if (bool(ctx, "json")) json({ kind, id, revoked });
      else out(revoked ? green(`✓ approval withdrawn for ${id}`) : dim(`${id} was not approved`));
      return 0;
    }
    const record = await be.call<ApprovalRecord>("approve", {
      kind,
      room,
      id,
      ...(note === "" ? {} : { note }),
    });
    if (bool(ctx, "json")) json(record);
    else {
      out(green(`✓ approved locally`) + dim(` ${kind} ${id}`));
      out(dim("  recorded on this machine only — never published to the network"));
      out(`  ${bold(`komnet ${kind} ${kind === "task" ? "claim" : "update"} ${room} ${id} …`)}`);
    }
    return 0;
  });
}

async function cmdApprovals(ctx: Ctx): Promise<number> {
  return await withBackend(ctx, async (be) => {
    const records = await be.call<ApprovalRecord[]>("approvals");
    if (bool(ctx, "json")) {
      json(records);
      return 0;
    }
    if (records.length === 0) {
      out(dim("nothing approved on this machine"));
      return 0;
    }
    for (const record of records) {
      out(
        `${cyan(record.kind.padEnd(7))} ${bold(record.id)} ${dim(`#${record.room} · ${ago(record.approvedAt)}`)}`,
      );
      if (record.note !== undefined) out(dim(`  ${record.note}`));
    }
    return 0;
  });
}

/** Show the effective machine-local policy, and where each value came from. */
async function cmdPolicy(ctx: Ctx): Promise<number> {
  const path = ctx.layout.policyPath;
  if (bool(ctx, "init")) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    if (await pathExists(path)) {
      errline(red(`error: ${path} already exists`));
      errline(dim("  edit it directly; komnet never rewrites this file"));
      return 1;
    }
    // The home may not exist yet: setting rules before joining a network is a
    // reasonable first move, and this command must work on a fresh machine.
    await mkdir(ctx.layout.root, { recursive: true });
    await writeFile(path, policyTemplate(), { encoding: "utf8", mode: 0o600 });
    out(green("✓ wrote a commented policy file") + dim(` ${path}`));
    out(dim("  komnet reads it and never rewrites it, so your comments survive"));
    return 0;
  }

  // Read straight from disk rather than through the backend: this file is
  // machine-local, so asking a daemon about it would be indirection — and it
  // would make `komnet policy` fail on a machine that has not joined a network
  // yet, which is exactly when someone wants to set their rules.
  const resolved = await loadLocalPolicy(ctx.layout);
  if (bool(ctx, "json")) {
    json({ ...resolved, path });
    return 0;
  }
  const approvals = resolved.policy.approvals;
  out(`${bold("approvals")}`);
  out(`  inboundWork  ${cyan(approvals.inboundWork)}`);
  out(
    `  localAgents  ${approvals.localAgents.length === 0 ? dim("none — every other agent is remote") : approvals.localAgents.join(", ")}`,
  );
  out();
  const activation = resolved.policy.activation;
  out(`${bold("activation")}`);
  out(
    `  mode         ${activation.mode === "off" ? dim("off — komnet never starts an agent") : yellow(`${activation.mode}: ${activation.command.join(" ")}`)}`,
  );
  if (activation.mode !== "off") {
    out(`  maxPerHour   ${String(activation.maxPerHour)} ${dim("(this spends your plan)")}`);
  }
  out();
  if (resolved.sources.length === 0) {
    out(dim("all values are defaults; no policy file is present"));
    out(`write a commented one:  ${bold("komnet policy --init")}`);
  } else {
    out(dim(`from: ${resolved.sources.join(", ")}`));
  }
  return 0;
}

/**
 * Take, release, or inspect an advisory lease on a shared resource.
 *
 * Replaces the "BUILD-START … BUILD-DONE" convention two agents invented out of
 * chat messages: same idea, but the hold expires on its own and the answer to
 * "did I get it?" is checked rather than assumed.
 */
async function cmdClaim(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1];
  if (sub === "release") {
    const room = ctx.positionals[2];
    const resource = ctx.positionals[3];
    if (room === undefined || resource === undefined) {
      usage("claim release needs <room> <resource>");
    }
    assertRoomId(room);
    return await withBackend(ctx, async (be) => {
      const { released } = await be.call<{ released: boolean }>("claimRelease", { room, resource });
      if (bool(ctx, "json")) json({ resource, released });
      else out(released ? green(`✓ released ${resource}`) : dim(`you do not hold ${resource}`));
      return 0;
    });
  }

  const room = ctx.positionals[1];
  const resource = ctx.positionals[2];
  if (room === undefined || resource === undefined) {
    usage("claim needs <room> <resource> [note] — or: claim release <room> <resource>");
  }
  assertRoomId(room);
  const note = ctx.positionals.slice(3).join(" ");
  const ttlSeconds = num(ctx, "ttl");

  return await withBackend(ctx, async (be) => {
    const result = await be.call<{ granted: boolean; status: ClaimStatus | null }>("claim", {
      room,
      resource,
      ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      ...(note === "" ? {} : { note }),
    });
    if (bool(ctx, "json")) {
      json(result);
      return result.granted ? 0 : 5;
    }
    if (result.granted) {
      out(green(`✓ holding ${resource}`) + dim(` until ${result.status?.expiresAt ?? "?"}`));
      out(dim(`  release it when done: komnet claim release ${room} ${resource}`));
      return 0;
    }
    // Exit 5, distinct from a failure: not getting a lock is a normal outcome
    // an agent must branch on, not an error it should retry blindly.
    errline(yellow(`✗ ${resource} is held by ${result.status?.holder ?? "another agent"}`));
    if (result.status !== null) {
      errline(dim(`  since ${ago(result.status.since)}, expires ${result.status.expiresAt}`));
      if (result.status.note !== "") errline(dim(`  "${result.status.note}"`));
    }
    errline(dim("  wait for it to be released or to expire; do not proceed in parallel"));
    return 5;
  });
}

async function cmdClaims(ctx: Ctx): Promise<number> {
  const room = ctx.positionals[1];
  if (room === undefined) usage("claims needs a room");
  assertRoomId(room);
  return await withBackend(ctx, async (be) => {
    const claims = await be.call<ClaimStatus[]>("claims", { room });
    const live = claims.filter((claim) => !claim.expired);
    if (bool(ctx, "json")) {
      json(live);
      return 0;
    }
    if (live.length === 0) {
      out(dim(`nothing is claimed in ${room}`));
      return 0;
    }
    for (const claim of live) {
      out(
        `${bold(claim.resource.padEnd(28))} ${cyan(claim.holder.padEnd(18))} ` +
          dim(`since ${ago(claim.since)} · expires ${claim.expiresAt}`),
      );
      if (claim.note !== "") out(dim(`  ${claim.note}`));
      if (claim.contenders.length > 0) {
        out(yellow(`  waiting: ${claim.contenders.join(", ")}`));
      }
    }
    return 0;
  });
}

async function cmdAgenda(ctx: Ctx): Promise<number> {
  const limit = num(ctx, "limit");
  const includeUnclaimed = bool(ctx, "mine") ? false : undefined;
  return await withBackend(ctx, async (be) => {
    const agenda = await be.call<Agenda>("agenda", {
      ...(limit === undefined ? {} : { limit }),
      ...(includeUnclaimed === undefined ? {} : { includeUnclaimed }),
    });
    if (bool(ctx, "json")) json(agenda);
    else renderAgenda(agenda);
    return 0;
  });
}

async function cmdRead(ctx: Ctx): Promise<number> {
  const roomId = ctx.positionals[1];
  if (roomId === undefined) usage("read needs a room");
  assertRoomId(roomId);
  const thread = str(ctx, "thread");

  return await withBackend(ctx, async (be) => {
    const messages = await be.call<Message[]>("read", {
      room: roomId,
      limit: num(ctx, "limit") ?? 50,
      ...(thread === undefined ? {} : { thread }),
    });
    if (bool(ctx, "json")) json(messages.map(messageToJson));
    else renderMessages(messages);
    return 0;
  });
}

async function cmdHistory(ctx: Ctx): Promise<number> {
  const roomId = ctx.positionals[1];
  if (roomId === undefined) usage("history needs a room");
  assertRoomId(roomId);
  const since = str(ctx, "since");
  const limit = num(ctx, "limit");

  return await withBackend(ctx, async (be) => {
    const messages = await be.call<Message[]>("history", {
      room: roomId,
      ...(since === undefined ? {} : { since }),
      ...(limit === undefined ? {} : { limit }),
    });
    if (bool(ctx, "json")) json(messages.map(messageToJson));
    else renderMessages(messages);
    return 0;
  });
}

async function cmdSearch(ctx: Ctx): Promise<number> {
  const query = ctx.positionals.slice(1).join(" ");
  if (query === "") usage("search needs a query");
  const room = str(ctx, "room");

  return await withBackend(ctx, async (be) => {
    const hits = await be.call<{ room: string; message: Message }[]>("search", {
      query,
      ...(room === undefined ? {} : { room }),
      limit: num(ctx, "limit") ?? 20,
    });
    if (bool(ctx, "json")) {
      json(hits.map((h) => ({ room: h.room, ...messageToJson(h.message) })));
      return 0;
    }
    if (hits.length === 0) {
      out(dim("no matches in the live window — try 'komnet history <room>' to search deeper"));
      return 0;
    }
    for (const { room: r, message } of hits) {
      const line = message.body
        .trim()
        .split("\n")
        .find((l) => l.toLowerCase().includes(query.toLowerCase()));
      out(`${cyan(r)} ${bold(message.header.from)} ${dim(ago(message.header.ts))}`);
      out(`  ${line ?? message.body.trim().split("\n")[0] ?? ""}`);
      out(dim(`  ${message.header.id}`));
    }
    return 0;
  });
}

/**
 * Where one message actually got to.
 *
 * "Sent" answered the narrowest possible question — this machine wrote a
 * commit — and everything a sender actually wanted to know was scattered across
 * four other commands, so nobody assembled it. An unread message and an ignored
 * one looked identical, which is the state this exists to end.
 */
async function cmdTrace(ctx: Ctx): Promise<number> {
  const messageId = ctx.positionals[1];
  if (messageId === undefined) usage("trace needs a message id");

  return await withBackend(ctx, async (be) => {
    const trace = await be.call<TraceRow | null>("trace", { messageId });
    if (trace === null) {
      errline(red(`✗ no message ${messageId} in the rooms this agent follows`));
      errline(dim("  trace reads the live window of subscribed rooms; try 'komnet sync' first"));
      return 1;
    }
    if (bool(ctx, "json")) {
      json(trace);
      return 0;
    }

    out(`${bold(trace.id)} ${dim(`#${trace.room} · from ${trace.from} · needs:${trace.needs}`)}`);
    out(`  ${green("✓")} stored    ${dim("committed here — durable, cannot be lost")}`);
    out(
      trace.pushed
        ? `  ${green("✓")} pushed    ${dim("on the remote; every peer can fetch it")}`
        : `  ${yellow("⧗")} pushed    ${yellow("not on the remote yet")} ${dim("— komnet sync")}`,
    );
    if (trace.recipients.length === 0) {
      out(`  ${dim("· addressed to nobody in particular — nothing to await")}`);
      return 0;
    }
    for (const who of trace.recipients) {
      // Ordered weakest to strongest, and each line says only what it knows:
      // a receipt means an agent processed its inbox, never that it understood.
      const state = !routableYes(who)
        ? red("will NOT arrive — they do not follow this room")
        : who.answered
          ? green("answered")
          : who.read
            ? cyan(`read${who.readAt === undefined ? "" : ` ${ago(who.readAt)}`}`)
            : yellow("not read yet");
      out(`  ${who.agent.padEnd(20)} ${state}`);
    }
    out();
    out(
      dim("read = their receipt covers this id (an agent processed it, not that a model agreed)."),
    );
    return 0;
  });
}

/** `unknown` counts as routable: an older peer publishes no room list. */
function routableYes(who: { routable: string }): boolean {
  return who.routable !== "no";
}

interface TraceRow {
  id: string;
  room: string;
  thread: string;
  from: string;
  needs: string;
  stored: boolean;
  pushed: boolean;
  recipients: {
    agent: string;
    routable: string;
    read: boolean;
    readAt?: string;
    answered: boolean;
  }[];
}

interface InboxRow {
  id: string;
  room: string;
  from: string;
  ts: string;
  kind: string;
  needs: string;
  priority: string;
  thread: string;
  tags: string[];
  path: string;
  body: string;
  processedAt: string | null;
}

/**
 * Which networks one read covers: the bound one, or every configured one.
 *
 * An agent waiting for work should not have to know which transport repo the
 * answer will arrive on. `--all-networks` is what makes "am I needed" a
 * question about this agent rather than about a network it had to pick first.
 */
async function readScope(ctx: Ctx, be: Backend): Promise<(string | undefined)[]> {
  if (!bool(ctx, "all-networks")) return [undefined];
  const networks = await be.networks().catch(() => []);
  return networks.length === 0 ? [undefined] : networks.map((net) => net.id);
}

/**
 * One inbox view over every configured network.
 *
 * Each row carries the network it came from, because acting on it means
 * answering there — and a merged list that hid which repo an item belonged to
 * would be a worse lie than the per-network view it replaces. Health travels
 * per network too: one unreachable transport must not make the others look
 * quiet, and it must not make this read fail either.
 */
async function inboxAcrossNetworks(
  ctx: Ctx,
  be: Backend,
  networks: (string | undefined)[],
  query: Record<string, unknown>,
): Promise<number> {
  const sections = await Promise.all(
    networks.map(async (network) => {
      const [health, items] = await Promise.all([
        be.call<TransportHealth>("health", {}, network).catch(() => null),
        be.call<InboxRow[]>("inbox", query, network).catch(() => [] as InboxRow[]),
      ]);
      return { network: network ?? "?", health, items };
    }),
  );

  if (bool(ctx, "json")) {
    json({ networks: sections });
    return 0;
  }
  const total = sections.reduce((sum, section) => sum + section.items.length, 0);
  for (const section of sections) {
    if (section.health?.degraded === true) {
      errline(`${yellow("!")} ${section.network}: ${renderDegraded(section.health)}`);
    }
    if (section.items.length === 0) continue;
    out(bold(`${section.network}`));
    renderInbox(section.items);
    out();
  }
  if (total === 0) {
    out(dim(`inbox empty across ${String(sections.length)} network(s)`));
    out(dim("  komnet mentions — messages naming you in rooms you have not joined"));
  }
  return 0;
}

async function cmdInbox(ctx: Ctx): Promise<number> {
  const room = str(ctx, "room");
  const needs = str(ctx, "needs");
  const tag = list(ctx, "tag")[0];

  return await withBackend(ctx, async (be) => {
    const scope = await readScope(ctx, be);
    const query = {
      ...(room === undefined ? {} : { room }),
      ...(needs === undefined ? {} : { needs }),
      ...(tag === undefined ? {} : { tag }),
    };
    if (scope.length > 1) return await inboxAcrossNetworks(ctx, be, scope, query);

    const [health, items] = await Promise.all([
      be.call<TransportHealth>("health"),
      be.call<InboxRow[]>("inbox", query),
    ]);
    // Said before the list, not after: an empty inbox from a broken transport
    // is the one output a reader must not take at face value.
    if (health.degraded && !bool(ctx, "json")) errline(renderDegraded(health));

    if (bool(ctx, "drain")) {
      const result = await be.call<{ drained: number; refused: string[] }>("inboxDrain", {
        ids: items.map((i) => i.id),
        rooms: [...new Set(items.map((i) => i.room))],
      });
      if (bool(ctx, "json")) {
        json({
          health,
          drained: result.drained,
          messages: items.filter((i) => i.needs !== "human"),
          awaitingHuman: items.filter((i) => i.needs === "human"),
        });
      } else {
        renderInbox(items);
        out();
        out(green(`✓ drained ${String(result.drained)}`));
        if (result.refused.length > 0) {
          out(
            red(
              `  ${String(result.refused.length)} left pending — 'needs: human' items require a person.`,
            ),
          );
        }
      }
      return 0;
    }

    if (bool(ctx, "json")) json({ health, items });
    else if (bool(ctx, "brief")) {
      // The brief is what a SessionStart hook injects, so it leads with the
      // work this agent already had in flight rather than with other agents'
      // mail. A room that will not open must not cost the session its mail, so
      // an unreadable agenda degrades to the mail alone.
      const resume = await be.call<ResumePoint[]>("resume", {}).catch(() => []);
      renderInboxBrief(items, resume);
    } else renderInbox(items);
    return 0;
  });
}

/**
 * What to do when a thread hits its reply budget.
 *
 * The failure this prevents: agents treated a parked thread as finished and
 * opened a new one, splitting a single incident across two and discarding the
 * context. One human message in the SAME thread refills the budget.
 */
function replyBudgetHint(thread: string): string {
  return (
    yellow("  this thread hit its reply budget") +
    `\n  ${dim("do NOT open a new thread — that splits the work and loses the context")}` +
    `\n  ${dim("one human reply in this thread refills it:")}` +
    `\n    ${bold(`komnet answer <id> "<their words>" --as-human`)}` +
    `\n  ${dim(`thread ${thread}`)}`
  );
}

/**
 * The warning shown when the local view cannot be trusted.
 *
 * Names what to do, because "degraded" alone leaves a reader guessing whether
 * an empty inbox means quiet or broken — which is the confusion this exists to
 * end.
 */
function renderDegraded(health: TransportHealth): string {
  const age =
    health.ageSeconds === null ? "never synced" : `last synced ${ago(health.lastSyncAt as string)}`;
  const since = health.failingSince === undefined ? "" : ` since ${ago(health.failingSince)}`;
  return (
    yellow(`! this view may be incomplete — ${age}`) +
    (health.reason === undefined ? "" : `\n  ${dim(`sync failing${since}: ${health.reason}`)}`) +
    `\n  ${dim("an empty list here means nothing reached this machine, not that nothing was said")}` +
    `\n  ${dim("check the transport: komnet doctor")}`
  );
}

interface SealOutcome {
  roomId: string;
  sealed: number;
  kept: number;
  digest: string | null;
  digests?: string[];
  decisionsPromoted: number;
  skipped?: string;
}

async function cmdSeal(ctx: Ctx): Promise<number> {
  const roomId = ctx.positionals[1];
  if (roomId === undefined) usage("seal needs a room");
  assertRoomId(roomId);

  return await withBackend(ctx, async (be) => {
    if (bool(ctx, "check")) {
      const decision = await be.call<{
        shouldSeal: boolean;
        reason: string;
        keeping: number;
        toSeal: unknown[];
      }>("sealCheck", { room: roomId });
      if (bool(ctx, "json")) {
        // toSeal carries whole messages; a summary is what a caller wants here.
        json({
          room: roomId,
          shouldSeal: decision.shouldSeal,
          reason: decision.reason,
          wouldSeal: decision.toSeal.length,
          keeping: decision.keeping,
        });
        return 0;
      }
      out(
        decision.shouldSeal
          ? `${yellow("due")} ${decision.reason} · keeping ${String(decision.keeping)}`
          : `${green("not due")} ${dim(decision.reason)}`,
      );
      return 0;
    }

    const result = await be.call<SealOutcome>("seal", { room: roomId });
    if (bool(ctx, "json")) {
      json(result);
      return 0;
    }
    if (result.sealed === 0) {
      out(dim(`nothing sealed — ${result.skipped ?? "nothing outside the window"}`));
      return 0;
    }
    out(
      green(`✓ sealed ${String(result.sealed)} message(s)`) +
        dim(` · keeping ${String(result.kept)}`),
    );
    const digests = result.digests ?? (result.digest === null ? [] : [result.digest]);
    for (const digest of digests) out(`  digest    ${digest}`);
    if (result.decisionsPromoted > 0) {
      out(`  decisions ${String(result.decisionsPromoted)} promoted (never pruned)`);
    }
    out(dim(`  the sealed messages remain in git history: komnet history ${roomId}`));
    return 0;
  });
}

interface ReceiptRow {
  agent: string;
  room: string;
  readThrough: string | null;
  count: number;
  updatedAt: string;
}

/**
 * Who has read what, in one room.
 *
 * The question this answers — "did anyone actually receive that?" — had no
 * answer before. `seen` in a message header looks like a read receipt and is
 * not: it is the transport commit the AUTHOR had observed when writing.
 */
async function cmdReceipts(ctx: Ctx): Promise<number> {
  const roomId = ctx.positionals[1];
  if (roomId === undefined) usage("receipts needs a room: komnet receipts <room>");
  assertRoomId(roomId);
  const since = str(ctx, "reply-to");

  return await withBackend(ctx, async (be) => {
    const rows = await be.call<ReceiptRow[]>("receipts", { room: roomId });
    if (bool(ctx, "json")) {
      json(
        since === undefined
          ? rows
          : rows.map((row) => ({
              ...row,
              read: row.readThrough !== null && row.readThrough >= since,
            })),
      );
      return 0;
    }
    if (rows.length === 0) {
      out(dim(`no read receipts in #${roomId} yet`));
      out(dim("  an agent publishes one when it drains its inbox for the room"));
      return 0;
    }
    for (const row of rows) {
      // ULIDs sort chronologically, so comparing ids IS comparing time.
      const mark =
        since === undefined
          ? " "
          : row.readThrough !== null && row.readThrough >= since
            ? green("✓")
            : yellow("·");
      out(
        `${mark} ${bold(row.agent.padEnd(20))} ${dim(
          `read ${String(row.count)} · through ${row.readThrough ?? "nothing"} · ${ago(row.updatedAt)}`,
        )}`,
      );
    }
    if (since !== undefined) {
      out();
      out(dim("✓ means that agent processed a message at least as new as --reply-to."));
      out(dim("  It is only meaningful if the message was actually routed to them."));
    }
    return 0;
  });
}

/**
 * Messages naming this agent in rooms it does not follow.
 *
 * Routing works within subscriptions, so "addressed to you" is quietly weaker
 * than it sounds: a mention in a room you never joined reaches nothing. This is
 * the explicit question, kept out of `sync` because folding it in would fetch
 * every room on the network on every poll (ADR 0008).
 */
async function cmdMentions(ctx: Ctx): Promise<number> {
  return await withBackend(ctx, async (be) => {
    const found =
      await be.call<
        { room: string; id: string; from: string; ts: string; needs: string; kind: string }[]
      >("mentions");
    if (bool(ctx, "json")) {
      json(found);
      return 0;
    }
    if (found.length === 0) {
      out(dim("nothing addressed to you in rooms you do not follow"));
      return 0;
    }
    const rooms = new Set<string>();
    for (const item of found) {
      rooms.add(item.room);
      out(
        `${cyan(item.room.padEnd(16))} ${bold(item.from.padEnd(18))} ` +
          `${item.needs === "human" ? red("needs:human") : dim(`needs:${item.needs}`)}  ${dim(ago(item.ts))}`,
      );
      out(dim(`  ${item.id}`));
    }
    out();
    out(`${String(found.length)} mention(s) in ${String(rooms.size)} room(s) you have not joined.`);
    for (const room of rooms) out(dim(`  komnet room join ${room}`));
    return 0;
  });
}

async function cmdSync(ctx: Ctx): Promise<number> {
  return await withBackend(ctx, async (be) => {
    const report = await be.call<{
      roomsPolled: number;
      changed: unknown[];
      recorded: number;
      delivered: number;
      anomalies: { status: string; path: string }[];
      unreadable: unknown[];
    }>("sync");
    if (bool(ctx, "json")) {
      json(report);
      return 0;
    }
    out(
      `polled ${String(report.roomsPolled)} room(s) · ` +
        `${String(report.changed.length)} changed · ` +
        `${String(report.recorded)} new message(s) · ` +
        `${String(report.delivered)} delivered to inbox`,
    );
    if (report.anomalies.length > 0) {
      out(
        red(
          `⚠ ${String(report.anomalies.length)} protocol anomaly/anomalies (modified or deleted messages):`,
        ),
      );
      for (const a of report.anomalies.slice(0, 5)) out(red(`  ${a.status} ${a.path}`));
    }
    if (report.unreadable.length > 0) {
      out(yellow(`⚠ ${String(report.unreadable.length)} unreadable message file(s)`));
    }
    return 0;
  });
}

/**
 * List the networks on this machine, and choose which one commands mean.
 *
 * Multi-network has always existed in the config, and the daemon has always
 * polled every one of them — but changing which one a bare command meant took
 * editing `config.yaml` by hand, and reading another one meant `--network` on
 * every single invocation. So in practice people ran one network per machine
 * and reopened editors to switch, which is the opposite of what the transport
 * being a plain git remote makes possible.
 *
 * `use` writes `defaultNetwork` and nothing else. That matters for the case it
 * was avoided for: a running MCP server re-resolves the default on its next
 * call, so switching does **not** interrupt an agent session — no restart, no
 * reconnect, no lost context.
 */
async function cmdNetwork(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1] ?? "list";

  if (sub === "use") {
    const wanted = ctx.positionals[2];
    if (wanted === undefined) usage("network use needs a network id");
    if (ctx.config.networks[wanted] === undefined) {
      errline(red(`✗ unknown network ${wanted}`));
      errline(dim(`  have: ${Object.keys(ctx.config.networks).join(", ") || "none"}`));
      errline(dim(`  add one with: komnet init --repo <url> --network ${wanted}`));
      return 1;
    }
    if (ctx.config.defaultNetwork === wanted) {
      out(dim(`already on ${wanted}`));
      return 0;
    }
    ctx.config.defaultNetwork = wanted;
    await saveConfig(ctx.layout.configPath, ctx.config);
    out(green(`✓ default network is now ${bold(wanted)}`));
    out(dim("  running agent sessions pick this up on their next call — no restart needed"));
    return 0;
  }

  if (sub !== "list") usage(`unknown network command '${sub}' (list | use <id>)`);

  return await withBackend(ctx, async (be) => {
    const networks = await be.networks();
    if (bool(ctx, "json")) {
      json(networks);
      return 0;
    }
    if (networks.length === 0) {
      out(dim("no networks configured"));
      out(dim("  komnet init --repo <url>"));
      return 0;
    }
    for (const net of networks) {
      const mark = net.current ? green("→") : " ";
      const rooms = net.subscriptions.length === 0 ? dim("no rooms") : net.subscriptions.join(", ");
      out(`${mark} ${bold(net.id.padEnd(18))} ${rooms}`);
      out(`  ${dim(net.remote)}`);
    }
    if (networks.length > 1) {
      out();
      out(dim("komnet network use <id> · or --network <id> on any single command"));
      out(dim("reads take --all-networks, so waiting does not mean picking one"));
    }
    return 0;
  });
}

async function cmdStatus(ctx: Ctx): Promise<number> {
  return await withBackend(ctx, async (be) => {
    const status = await be.call<{
      networkId: string;
      remote: string;
      agentId: string;
      subscriptions: string[];
      pending: number;
      pendingHuman: number;
      lastSyncAt: string | null;
      tasks?: AgendaCounts;
      attention?: Attention;
      surroundings?: Surroundings;
      health?: TransportHealth;
      daemon?: { sessionLive: boolean; cadence: string; sessions: number };
    }>("status");
    if (bool(ctx, "json")) {
      json({ ...status, mode: be.mode });
      return 0;
    }
    out(`${bold(status.networkId)} ${dim(status.remote)}`);
    // The home, not just the id: "which identity am I" is a question about
    // which KOMNET_HOME this invocation resolved to.
    out(
      `agent      ${status.agentId}` +
        dim(
          ` · ${ctx.layout.root}` +
            (process.env["KOMNET_HOME"] === undefined
              ? process.env["KOMNET_AGENT"] === undefined
                ? str(ctx, "agent") === undefined
                  ? " (default home)"
                  : " (--agent)"
                : " (KOMNET_AGENT)"
              : " (KOMNET_HOME)"),
        ),
    );
    out(`rooms      ${status.subscriptions.join(", ") || dim("none")}`);
    out(
      `pending    ${String(status.pending)}${
        status.pendingHuman > 0 ? red(` (${String(status.pendingHuman)} need a human)`) : ""
      }`,
    );
    // Split the pending count by whether it bears on the work in hand. Without
    // this the only way to find out was to open the inbox, and opening the
    // inbox is the context switch the reader was trying to decide about.
    const attention = status.attention;
    if (attention !== undefined && attention.interrupting.length > 0) {
      const reasons = [...new Set(attention.interrupting.map((i) => i.reason))].join(", ");
      out(
        `attention  ${yellow(`${String(attention.interrupting.length)} worth stopping for`)} ` +
          dim(`(${reasons})`) +
          (attention.deferred > 0 ? dim(` · ${String(attention.deferred)} can wait`) : ""),
      );
    }
    // Unread messages were the only thing status reported, so an agent could
    // read "nothing waiting" while owning work that had stalled for a week.
    const tasks = status.tasks;
    if (tasks !== undefined) {
      const owed = tasks.assigned + tasks.offered;
      out(
        `tasks      ${String(owed)} owed${
          tasks.unclaimed > 0 ? dim(` · ${String(tasks.unclaimed)} unclaimed`) : ""
        }${
          tasks.needsAttention > 0
            ? yellow(` · ${String(tasks.needsAttention)} need attention`)
            : ""
        }` + (owed + tasks.unclaimed > 0 ? dim("  (komnet task agenda)") : ""),
      );
    }
    // What is going on that this agent is not part of. An agent in one room
    // reads "pending 0" and concludes the network is quiet, when the team may
    // have started somewhere else entirely — and nothing ever said so.
    const around = status.surroundings;
    if (around !== undefined && (around.rooms.length > 0 || around.threads.length > 0)) {
      const parts = [
        around.rooms.length === 0
          ? null
          : `${String(around.rooms.length)} room(s) you have not joined: ${around.rooms.slice(0, 4).join(", ")}`,
        around.threads.length === 0
          ? null
          : `${String(around.threads.length)} conversation(s) started without you`,
      ].filter((part) => part !== null);
      out(`elsewhere  ${cyan(parts.join(" · "))}`);
      out(dim(`           komnet room list · komnet room join <id>`));
    }
    out(
      `last sync  ${status.lastSyncAt === null ? red("never") : ago(status.lastSyncAt)}` +
        (status.health?.degraded === true ? red("  · DEGRADED") : ""),
    );
    if (status.health?.degraded === true) out(renderDegraded(status.health));
    out(
      `daemon     ${
        be.mode === "daemon"
          ? green(`running · cadence ${status.daemon?.cadence ?? "?"}`) +
            dim(` · ${String(status.daemon?.sessions ?? 0)} session(s)`)
          : yellow("not running — delivery is pull-based (komnet sync)")
      }`,
    );
    return 0;
  });
}

async function cmdAgents(ctx: Ctx): Promise<number> {
  return await withBackend(ctx, async (be) => {
    const cards = await be.call<
      {
        id: string;
        human: { name: string; timezone: string };
        tool: string;
        role?: string;
        subscriptions?: string[];
      }[]
    >("agents");
    if (bool(ctx, "json")) {
      json(cards);
      return 0;
    }
    if (cards.length === 0) {
      out(dim("no agents registered"));
      return 0;
    }
    for (const c of cards) {
      out(
        `${bold(c.id.padEnd(20))} ${c.role ?? dim("role not published")} ${dim(
          `· ${c.human.name} · ${c.human.timezone} · ${c.tool}`,
        )}`,
      );
      // Which rooms they follow decides whether a mention reaches them at all.
      out(
        c.subscriptions === undefined
          ? dim("  rooms not published (older komnet)")
          : dim(`  rooms: ${c.subscriptions.length === 0 ? "none" : c.subscriptions.join(", ")}`),
      );
    }
    return 0;
  });
}

interface CliAgentProfile {
  id: string;
  updatedAt: string;
  role: string;
  mission: string;
  currentFocus: string;
  environment: { client: string; platform: string; architecture: string; workspace?: string };
  capabilities: string[];
  responsibilities: string[];
  constraints: string[];
  canHelpWith: string[];
}

function optionalList(ctx: Ctx, key: string): string[] | undefined {
  return ctx.values[key] === undefined ? undefined : list(ctx, key);
}

function renderProfile(profile: CliAgentProfile): void {
  out(`${bold(profile.id)} — ${profile.role}`);
  out(dim(`updated ${profile.updatedAt}`));
  out(`mission       ${profile.mission}`);
  out(`current focus ${profile.currentFocus}`);
  out(
    `environment   ${profile.environment.client} · ${profile.environment.platform}/${profile.environment.architecture}${
      profile.environment.workspace === undefined ? "" : ` · ${profile.environment.workspace}`
    }`,
  );
  for (const [label, values] of [
    ["capabilities", profile.capabilities],
    ["responsibilities", profile.responsibilities],
    ["constraints", profile.constraints],
    ["can help with", profile.canHelpWith],
  ] as const) {
    out(`${label.padEnd(14)} ${values.length === 0 ? dim("none declared") : values.join("; ")}`);
  }
}

async function cmdProfile(ctx: Ctx): Promise<number> {
  const action = ctx.positionals[1] === "update" ? "update" : "show";
  return await withBackend(ctx, async (be) => {
    if (action === "show") {
      const explicitShow = ctx.positionals[1] === "show";
      const agent = explicitShow ? ctx.positionals[2] : ctx.positionals[1];
      if (ctx.positionals.length > (explicitShow ? 3 : 2)) {
        usage("profile show accepts at most one agent id");
      }
      const profile = await be.call<CliAgentProfile | null>(
        "profileGet",
        agent === undefined ? {} : { agent },
      );
      if (bool(ctx, "json")) {
        json(profile);
        return 0;
      }
      if (profile === null) {
        out(dim(agent === undefined ? "profile not published" : `no profile for ${agent}`));
        return 0;
      }
      renderProfile(profile);
      return 0;
    }

    if (ctx.positionals.length > 2) usage("profile update accepts options, not positional text");
    const capabilities = optionalList(ctx, "capability");
    const responsibilities = optionalList(ctx, "responsibility");
    const constraints = optionalList(ctx, "constraint");
    const canHelpWith = optionalList(ctx, "help-with");
    const result = await be.call<{ published: boolean; profile: CliAgentProfile }>(
      "profileUpdate",
      {
        input: {
          ...(str(ctx, "role") === undefined ? {} : { role: str(ctx, "role") }),
          ...(str(ctx, "mission") === undefined ? {} : { mission: str(ctx, "mission") }),
          ...(str(ctx, "focus") === undefined ? {} : { currentFocus: str(ctx, "focus") }),
          ...(str(ctx, "workspace") === undefined ? {} : { workspace: str(ctx, "workspace") }),
          ...(capabilities === undefined ? {} : { capabilities }),
          ...(responsibilities === undefined ? {} : { responsibilities }),
          ...(constraints === undefined ? {} : { constraints }),
          ...(canHelpWith === undefined ? {} : { canHelpWith }),
        },
      },
    );
    if (bool(ctx, "json")) {
      json(result);
      return 0;
    }
    out(result.published ? green("✓ agent profile published") : dim("profile unchanged"));
    renderProfile(result.profile);
    return 0;
  });
}

interface MachineAgentJson {
  id: string;
  tool: string;
  human: string;
  status: string;
  lastSeen: string;
  lastActivity: string | null;
  sessions: number;
  rooms: string[] | null;
  role: string | null;
  focus: string | null;
  workspace: string | null;
}

interface MachineJson {
  id: string | null;
  label: string | null;
  humans: string[];
  contested: boolean;
  self: boolean;
  live: number;
  agents: MachineAgentJson[];
}

function presenceMark(status: string): string {
  if (status === "live") return green("●");
  if (status === "stale") return yellow("◐");
  return dim("○");
}

function renderMachineAgent(agent: MachineAgentJson, indent: string): void {
  out(
    `${indent}${presenceMark(agent.status)} ${bold(agent.id.padEnd(20))} ` +
      `${agent.role ?? dim("role not published")} ${dim(`· ${agent.tool}`)}`,
  );
  const context = [
    agent.focus === null ? null : `focus: ${agent.focus}`,
    agent.workspace === null ? null : `workspace: ${agent.workspace}`,
    agent.sessions > 0 ? `${String(agent.sessions)} session(s)` : null,
  ].filter((part): part is string => part !== null);
  if (context.length > 0) out(dim(`${indent}  ${context.join(" · ")}`));
  out(
    agent.rooms === null
      ? dim(`${indent}  rooms not published (older komnet)`)
      : dim(`${indent}  rooms: ${agent.rooms.length === 0 ? "none" : agent.rooms.join(", ")}`),
  );
}

/**
 * This computer's identity, and the agents sharing it.
 *
 * `machine set` exists for exactly one situation, and it is worth naming: two
 * laptops both called `macbook-pro` derive the same id, and every routing
 * decision downstream then treats them as one box. Nothing on the wire can
 * detect that reliably, so the fix is a person renaming one of them.
 */
async function cmdMachine(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1];

  if (sub === "set") {
    const id = ctx.positionals[2];
    if (id === undefined) usage("machine set needs an id: komnet machine set <id>");
    assertMachineId(id);
    ctx.config.agent.machine = { id, label: ctx.config.agent.machine.label };
    await saveConfig(ctx.layout.configPath, ctx.config);
    // The card carries the machine, so a rename that is not published leaves
    // every peer routing to the old group.
    let published = false;
    await withBackend(ctx, async (be) => {
      await be.call("announce", { status: "live" });
      published = true;
      return 0;
    }).catch(() => 1);
    if (bool(ctx, "json")) return (json({ machine: ctx.config.agent.machine, published }), 0);
    out(green(`✓ this computer is now ${id}`));
    out(
      published
        ? dim("  republished on the agent card; peers pick it up on their next sync")
        : yellow("  could not republish the card — run 'komnet presence --live' when reachable"),
    );
    return 0;
  }

  if (sub === "room") {
    return await withBackend(ctx, async (be) => {
      const result = await be.call<{ room: string; created: boolean; joined: boolean }>(
        "machineRoom",
      );
      if (bool(ctx, "json")) return (json(result), 0);
      out(
        green(`✓ #${result.room}`) +
          dim(
            result.created
              ? " created and joined"
              : result.joined
                ? " already existed — joined"
                : " already joined",
          ),
      );
      out(dim("  the agents on this computer share it; anything sent here reaches them all"));
      return 0;
    });
  }

  if (sub !== undefined)
    usage("unknown machine subcommand; use 'machine', 'machine set', or 'machine room'");

  return await withBackend(ctx, async (be) => {
    const machine = ctx.config.agent.machine;
    const peers = await be.call<MachineAgentJson[]>("peers");
    if (bool(ctx, "json")) return (json({ ...machine, peers }), 0);

    out(`${bold(machine.id)} ${dim(`· ${machine.label}`)}`);
    out(dim(`  this agent: ${ctx.config.agent.id}`));
    if (peers.length === 0) {
      out(dim("  no other agent has registered on this computer"));
      out(dim("  add one with: komnet agent add <id> --repo <url>"));
      return 0;
    }
    out("");
    out(dim(`  ${String(peers.length)} peer(s) here:`));
    for (const peer of peers) renderMachineAgent(peer, "  ");
    return 0;
  });
}

/**
 * The other agents on this computer.
 *
 * Separate from `agents` because the answer is used differently: a co-located
 * peer shares the filesystem, so work can be handed to it without moving
 * anything, and its claims on a path or a build are the ones that actually
 * collide with this agent's.
 */
async function cmdPeers(ctx: Ctx): Promise<number> {
  return await withBackend(ctx, async (be) => {
    const peers = await be.call<MachineAgentJson[]>("peers");
    if (bool(ctx, "json")) return (json(peers), 0);
    if (peers.length === 0) {
      out(dim(`no other agent has registered on ${ctx.config.agent.machine.id}`));
      return 0;
    }
    for (const peer of peers) renderMachineAgent(peer, "");
    return 0;
  });
}

/** The network grouped by computer rather than by agent id. */
async function cmdMachines(ctx: Ctx): Promise<number> {
  return await withBackend(ctx, async (be) => {
    const machines = await be.call<MachineJson[]>("machines");
    if (bool(ctx, "json")) return (json(machines), 0);
    if (machines.length === 0) {
      out(dim("no agents registered"));
      return 0;
    }
    for (const machine of machines) {
      const name =
        machine.id === null ? dim("(machine not published)") : bold(`machine:${machine.id}`);
      const label =
        machine.label === null || machine.label === machine.id ? "" : ` · ${machine.label}`;
      out(
        `${name}${dim(label)} ${dim(
          `· ${machine.humans.join(", ")} · ${String(machine.agents.length)} agent(s), ` +
            `${String(machine.live)} live`,
        )}${machine.self ? green("  ← this computer") : ""}`,
      );
      if (machine.contested) {
        out(
          yellow("  several people claim this id") +
            dim(" — most likely two computers whose hostnames match."),
        );
        out(dim("  on the odd one out, run: komnet machine set <a-different-id>"));
      }
      if (machine.id === null) {
        out(dim("  these agents run an older komnet and publish no machine; they can still"));
        out(dim("  be addressed by agent id, but no machine:<id> mention will reach them"));
      }
      for (const agent of machine.agents) renderMachineAgent(agent, "  ");
      out("");
    }
    return 0;
  });
}

async function cmdPresence(ctx: Ctx): Promise<number> {
  const declaring = bool(ctx, "live") || bool(ctx, "away");
  if (bool(ctx, "live") && bool(ctx, "away")) usage("pick one of --live or --away");

  return await withBackend(ctx, async (be) => {
    if (declaring) {
      const status = bool(ctx, "live") ? "live" : "away";
      const { published } = await be.call<{ published: boolean }>("announce", { status });
      if (bool(ctx, "json")) {
        json({ status, published });
        return 0;
      }
      out(
        published
          ? green(`✓ published presence: ${status}`)
          : dim(`already ${status} — nothing to publish`),
      );
      if (status === "live") {
        // Said plainly because the word "live" overclaims on its own: nothing
        // after this command keeps the assertion true. What was published is a
        // timestamp, and every reader ages it into an answer.
        out(dim("  this stamps 'seen now'; peers read live for 5m, then unknown, then away"));
      }
      return 0;
    }

    const rows = await be.call<
      {
        id: string;
        status: string;
        lastSeen: string;
        lastActivity?: string | null;
        human: string;
        timezone: string;
        sessions?: number;
      }[]
    >("presence");
    if (bool(ctx, "json")) {
      json(rows);
      return 0;
    }
    if (rows.length === 0) {
      out(dim("no agents registered"));
      return 0;
    }
    for (const r of rows) {
      const mark =
        r.status === "live"
          ? green("● live")
          : r.status === "stale"
            ? yellow("? stale")
            : dim("○ away");
      // Concurrent sessions are only worth showing when there is more than one:
      // the agent id is the participant, the count is how many windows are open.
      const concurrent = (r.sessions ?? 0) > 1 ? cyan(` ×${String(r.sessions)}`) : "";
      // Report both clocks only when they actually read differently. The card
      // is a declaration and the newest message is evidence; showing only the
      // declaration is what made a peer mid-task read as absent, but printing
      // both when they agree is noise on every ordinary row.
      const wrote = r.lastActivity == null ? null : ago(r.lastActivity);
      const declared = ago(r.lastSeen);
      const seen =
        wrote === null || wrote === declared || (r.lastActivity as string) <= r.lastSeen
          ? declared
          : `${wrote} (wrote) · card ${declared}`;
      out(
        `${mark}${concurrent}  ${bold(r.id.padEnd(20))} ` +
          dim(`${seen} · ${r.human} · ${r.timezone}`),
      );
    }
    if (be.mode !== "daemon") {
      out();
      out(
        dim(
          "no daemon: presence is stamped by 'komnet watch' and 'komnet handshake' while they run,\n" +
            "and ages to away on its own. For continuous presence: komnet daemon start",
        ),
      );
    }
    return 0;
  });
}

interface HandshakeReport {
  room: string;
  thread: string;
  message: Message;
  role: "open" | "ack";
  addressed: string[];
  peers: { id: string; status: string; lastSeen: string; tool: string; human: string }[];
  presencePublished: boolean;
  synced: boolean;
}

/**
 * First contact, as one command.
 *
 * The steps it folds together — announce, join, sync, greet, report who is
 * around — are each trivial and were each easy to forget, which is what made
 * getting two agents talking a conversation between two humans.
 *
 * It does not wait. The last thing it prints is the exact `komnet watch`
 * invocation for this thread, because the calling agent runs that as a
 * background monitor and is woken when the reply lands.
 */
async function cmdHandshake(ctx: Ctx): Promise<number> {
  const isAck = ctx.positionals[1] === "ack";
  const target = ctx.positionals[isAck ? 2 : 1];
  const note = ctx.positionals.slice(isAck ? 3 : 2).join(" ");
  const peers = list(ctx, "peer");

  if (target === undefined) {
    usage(
      isAck
        ? "handshake ack needs a message id: komnet handshake ack <message-id>"
        : "handshake needs a room: komnet handshake <room> [note]",
    );
  }
  if (!isAck) assertRoomId(target);

  return await withBackend(ctx, async (be) => {
    const report = await be.call<HandshakeReport>("handshake", {
      input: {
        ...(isAck ? { ackTo: target } : { room: target }),
        ...(note === "" ? {} : { note }),
        ...(peers.length > 0 && !isAck ? { peers } : {}),
      },
    });

    if (bool(ctx, "json")) {
      json({ ...report, message: messageToJson(report.message), watch: watchHint(report) });
      return 0;
    }

    out(
      report.role === "ack"
        ? green("✓ handshake acknowledged") + dim(` ${report.message.header.id}`)
        : green("✓ handshake sent") + dim(` ${report.message.header.id}`),
    );
    out(`room       #${report.room}`);
    out(`thread     ${report.thread}`);
    out(`addressed  ${report.addressed.join(", ")}`);
    out(
      `presence   ${report.presencePublished ? green("stamped live") : dim("already live")}` +
        (be.mode === "daemon" ? "" : yellow(" · no daemon: it ages to away in ~10m")),
    );
    if (!report.synced) {
      out(yellow("offline    queued — it goes out on the next successful sync"));
    }

    out();
    if (report.peers.length === 0) {
      out(dim("no other agents have registered on this network yet"));
    } else {
      for (const peer of report.peers) {
        const mark =
          peer.status === "live"
            ? green("● live")
            : peer.status === "stale"
              ? yellow("? stale")
              : dim("○ away");
        out(`${mark}  ${bold(peer.id.padEnd(20))} ${dim(`${ago(peer.lastSeen)} · ${peer.tool}`)}`);
      }
      if (!report.peers.some((peer) => peer.status === "live")) {
        out(dim("nobody is live — the reply may take hours. Do not wait on it."));
      }
    }

    if (report.role === "open") {
      out();
      out("watch for the reply:");
      out(`  ${bold(watchHint(report))}`);
    }
    return 0;
  });
}

function watchHint(report: HandshakeReport): string {
  return `komnet watch --thread ${report.thread}`;
}

/**
 * Identifier for THIS process's attachment to the network.
 *
 * The agent id stays stable and routable, so two windows of one tool are the
 * same participant; this is what distinguishes them. Taken from the
 * environment when a host supplies one — so a tool that already knows its own
 * session can reuse that id across commands — and minted per process otherwise.
 *
 * It is an opaque tag, never an identity: nothing authenticates it, and it
 * grants nothing.
 */
function sessionTag(): string {
  const supplied = process.env["KOMNET_SESSION"];
  if (supplied !== undefined && supplied.trim() !== "") return supplied.trim().slice(0, 64);
  return ulid();
}

/** The network beside this agent's inbox. See `Network.surroundings`. */
interface Surroundings {
  rooms: string[];
  threads: { room: string; thread: string; from: string; kind: string; needs: string }[];
}

/**
 * Report what is going on next to this agent, once per fact.
 *
 * An agent that joins one room and waits is structurally blind to the rest of
 * the network: routing keeps other rooms out of its inbox, and a conversation
 * started beside it was addressed to somebody else. Both of those are things it
 * would want to know, and neither has ever been said out loud — so waiting has
 * been indistinguishable from there being nothing to know.
 *
 * Metadata only, like every other line here: a room id and a thread id, never a
 * body. This tells an agent where to look; deciding to look is still its call,
 * and `komnet room join` / `komnet read --thread` are the deliberate next step.
 */
function reportSurroundings(
  around: Surroundings | null,
  rooms: Set<string>,
  threads: Set<string>,
): void {
  if (around === null) return;

  // Bounded, because the first poll on an established network would otherwise
  // list every room and every recent thread at once — a wall of context for an
  // agent that asked to be told when something happens. The count still says
  // how much was left out, and `komnet room list` is the full answer.
  const newRooms = around.rooms.filter((room) => !rooms.has(room));
  for (const room of newRooms.slice(0, WATCH_SURROUNDINGS_CAP)) {
    remember(rooms, room);
    out(
      `komnet-room id=${field(room, 60)} state=not-joined` +
        ` join=${field(`komnet room join ${room}`, 80)}`,
    );
  }
  if (newRooms.length > WATCH_SURROUNDINGS_CAP) {
    for (const room of newRooms.slice(WATCH_SURROUNDINGS_CAP)) remember(rooms, room);
    out(
      `komnet-room state=not-joined more=${String(newRooms.length - WATCH_SURROUNDINGS_CAP)}` +
        ` list=komnet+room+list`,
    );
  }

  // Newest first: a conversation that started a minute ago is likelier to still
  // be worth joining than one from this morning.
  const fresh = around.threads.filter((start) => !threads.has(start.thread)).reverse();
  for (const start of fresh.slice(0, WATCH_SURROUNDINGS_CAP)) {
    remember(threads, start.thread);
    out(
      `komnet-thread state=started room=${field(start.room, 60)}` +
        ` thread=${field(start.thread, 40)} from=${field(start.from, 60)}` +
        ` kind=${field(start.kind, 16)} needs=${field(start.needs, 12)} addressed-to=other`,
    );
  }
  if (fresh.length > WATCH_SURROUNDINGS_CAP) {
    for (const start of fresh.slice(WATCH_SURROUNDINGS_CAP)) remember(threads, start.thread);
    out(
      `komnet-thread state=started more=${String(fresh.length - WATCH_SURROUNDINGS_CAP)}` +
        ` read=komnet+room+list`,
    );
  }
}

/** How many surrounding rooms/threads one watcher names before summarising. */
const WATCH_SURROUNDINGS_CAP = 5;

const WATCH_DEFAULT_INTERVAL_S = 15;
const WATCH_MIN_INTERVAL_S = 2;
/**
 * Bounds the ids remembered for deduplication. Items leave the inbox when
 * drained, so the live set is small; this only caps the tail of parked
 * `needs: human` ids, which an agent structurally cannot drain (ADR 0012).
 */
const WATCH_SEEN_CAP = 5000;

/**
 * Stream inbox arrivals as one line each, for an agent to run as a monitor.
 *
 * **Metadata only, never a body.** Every line here becomes a notification in a
 * live agent session, and bodies are text written on other machines. Emitting
 * one would mean remote text entering an agent's context through a notification
 * that arrived on its own — the exact shape of injection the rest of this
 * design avoids. The agent fetches bodies deliberately, with `komnet inbox`,
 * at a point where it has already framed them as data.
 *
 * Failure is announced rather than swallowed: a watcher that goes quiet when
 * `komnet` starts failing is indistinguishable from a network with nothing to
 * say, and the agent would wait forever on a reply that can never arrive.
 *
 * Two properties this has to keep, both learned from watchers that lied:
 *
 * **Silence is only reported when it was checked.** A poll that could not reach
 * the remote knows nothing about the room, so every line carries whether the
 * view behind it was confirmed, and a `--wait` that expires says which kind of
 * nothing it found. "No new messages" from a watcher that has not synced in an
 * hour is a false negative, and an agent acts on it exactly as it would on the
 * truth.
 *
 * **An item already in the inbox is not an arrival.** `--wait` fires on
 * anything matching, including items pending since before it started, so a
 * watcher relaunched on an undrained inbox reported the same message as "just
 * arrived" three times running. Each line now says which it is, and
 * `--new-only` waits for a genuine arrival.
 */
async function cmdWatch(ctx: Ctx): Promise<number> {
  const room = str(ctx, "room");
  const thread = str(ctx, "thread");
  const tag = list(ctx, "tag")[0];
  const needs = str(ctx, "needs");
  const once = bool(ctx, "once");
  const newOnly = bool(ctx, "new-only");
  const wait = num(ctx, "wait");
  const interval = Math.max(WATCH_MIN_INTERVAL_S, num(ctx, "interval") ?? WATCH_DEFAULT_INTERVAL_S);

  return await withBackend(
    ctx,
    async (be) => {
      const seen = new Set<string>();
      let consecutiveFailures = 0;
      let announcedFailure = false;
      // `--wait` turns the stream into a single blocking question: "tell me when
      // one matching thing arrives". An agent turn cannot spin, so without this
      // the only options were to burn turns polling or hand back to the human.
      let matched = 0;
      // Whether the most recent poll actually reached the remote. `--wait`
      // reports it on timeout so "nothing came" cannot be confused with
      // "nothing could be checked".
      let confirmed = false;
      // Reported once each per watcher, not once per poll: a room that exists
      // and a conversation that started are standing facts, and repeating them
      // every fifteen seconds would cost an agent tokens to be told nothing.
      const announcedRooms = new Set<string>();
      const announcedThreads = new Set<string>();
      /** Items already pending when a `--new-only` watcher armed. */
      let backlog = 0;
      // Everything already pending when the watcher armed. Those are backlog,
      // not arrivals, and saying so is what stops a relaunched watcher
      // announcing week-old mail as news.
      let armed = false;

      // Which networks this watcher covers. An agent waiting for work should
      // not have to know which transport repo the answer will arrive on, and
      // picking one was previously the price of waiting at all.
      const scope = await readScope(ctx, be);

      const pollOne = async (network: string | undefined): Promise<void> => {
        try {
          // In direct mode nothing else is pulling, so the watcher has to. A
          // watching session does not need to: opening it wakes the daemon into
          // its hot cadence, and syncing here would only fight that. `--once` is
          // not a session, though — it asks "what is there right now", and
          // answering that from the cache would report a stale inbox as empty.
          if (be.mode !== "daemon" || once) await be.call("sync", {}, network);

          const [health, items, around] = await Promise.all([
            be.call<TransportHealth>("health", {}, network),
            be.call<InboxRow[]>(
              "inbox",
              {
                ...(room === undefined ? {} : { room }),
                ...(needs === undefined ? {} : { needs }),
                ...(tag === undefined ? {} : { tag }),
              },
              network,
            ),
            // What is happening beside this agent's inbox. Free — the room list
            // rides on the same poll — and the reason an agent that joined one
            // room and waited had no way to learn the team had started another.
            be.call<Surroundings>("surroundings", {}, network).catch(() => null),
          ]);
          reportSurroundings(around, announcedRooms, announcedThreads);

          // With a daemon the watcher does not sync itself, so "did anyone
          // look" is a question about the daemon's last sync, not about this
          // process. A degraded transport means this poll saw a cache nobody
          // has refreshed — the silence it would otherwise report is unearned.
          confirmed = !health.degraded;
          if (!confirmed && !announcedFailure) {
            announcedFailure = true;
            out(
              `watch-degraded reason=${field(health.reason ?? "sync has not succeeded", 120)}` +
                ` last-sync=${field(health.lastSyncAt ?? "never", 40)}`,
            );
          } else if (confirmed && announcedFailure) {
            out("watch-recovered komnet reachable again");
            announcedFailure = false;
          }
          consecutiveFailures = 0;

          for (const item of items) {
            if (seen.has(item.id)) continue;
            remember(seen, item.id);
            if (thread !== undefined && item.thread !== thread) continue;
            // Pending before this watcher existed, versus arrived while it was
            // watching. Only the second is news.
            const state = armed ? "new" : "pending";
            if (state === "new" || !newOnly) matched += 1;
            // `--new-only` says the backlog is not what this watcher is for, so
            // it does not list it either. Printing it and then refusing to wake
            // on it was the worst of both: an agent read the same items again
            // and could not tell why they had not satisfied the wait.
            if (newOnly && state === "pending") {
              backlog += 1;
              continue;
            }
            out(
              `komnet-inbox state=${state} id=${field(item.id, 40)} room=${field(item.room, 60)}` +
                // Named only when this watcher spans several: acting on the item
                // means answering on that network, so a merged stream that hid
                // which one it came from would be worse than not merging.
                (network === undefined ? "" : ` network=${field(network, 60)}`) +
                ` from=${field(item.from, 60)} needs=${field(item.needs, 12)}` +
                ` priority=${field(item.priority, 12)} kind=${field(item.kind, 16)}` +
                ` thread=${field(item.thread, 40)} tags=${field((item.tags ?? []).join(","), 80)}`,
            );
          }
          // Said once, as a number: the agent should know a backlog exists
          // without being handed it again on a watcher that asked for arrivals.
          if (!armed && backlog > 0) {
            out(`watch-backlog pending=${String(backlog)} read=komnet+inbox`);
          }
          armed = true;
        } catch (error) {
          confirmed = false;
          consecutiveFailures += 1;
          // One line after a sustained outage, then silence until it recovers:
          // enough for the agent to notice and run `komnet doctor`, not enough to
          // flood a session while a laptop is asleep.
          if (consecutiveFailures >= 3 && !announcedFailure) {
            announcedFailure = true;
            out(
              `watch-degraded consecutive-failures=${String(consecutiveFailures)}` +
                ` reason=${field(describeError(error), 120)}`,
            );
          }
        }
      };

      /** One pass over every network in scope. Sequential: the daemon is one socket. */
      const poll = async (): Promise<void> => {
        for (const network of scope) await pollOne(network);
      };

      const filters = [
        room === undefined ? null : `room:${room}`,
        thread === undefined ? null : `thread:${thread}`,
        tag === undefined ? null : `tag:${tag}`,
        needs === undefined ? null : `needs:${needs}`,
      ].filter((f) => f !== null);
      // The effective context, printed before anything else. A watcher armed on
      // the wrong network reports the right answer about the wrong place, and
      // that reads exactly like a quiet room — so which network and identity
      // this process resolved is the first thing its reader has to be able to
      // check, not something to reconstruct from a bug report afterwards.
      const context = await be
        .call<{ networkId: string; agentId: string; subscriptions: string[] }>("status")
        .catch(() => null);
      out(
        `watch-armed poll=${String(interval)}s mode=${be.mode}` +
          ` sync=${be.mode === "daemon" ? "daemon" : "self"}` +
          ` network=${field(
            scope.length > 1 ? `all(${scope.join(",")})` : (context?.networkId ?? "unknown"),
            120,
          )}` +
          ` agent=${field(context?.agentId ?? "unknown", 60)}` +
          `${wait === undefined ? "" : ` wait=${String(wait)}s`}` +
          `${newOnly ? " new-only=true" : ""}` +
          ` filter=${filters.length === 0 ? "none" : filters.join(",")}`,
      );
      if (room !== undefined && context !== null && !context.subscriptions.includes(room)) {
        // Watching a room this agent does not follow can only ever report
        // nothing: routing never files it into this inbox in the first place.
        out(
          `watch-degraded reason=${field(`not subscribed to #${room} — komnet room join ${room}`, 120)}`,
        );
      }

      await poll();
      if (once) return 0;

      // A watching agent IS a live session, and in direct mode nothing else says
      // so — the daemon publishes presence on session open, but there is no
      // daemon here. Without this a peer blocked on `--wait` reads as `away`, and
      // the agent that greeted it is told "nobody is live, the reply may take
      // hours" about a peer that is listening right now.
      //
      // `--once` is excluded deliberately: it is a peek, not a session, and
      // claiming presence for the length of one poll would be the same kind of
      // overclaim in the other direction.
      const announcing = be.mode !== "daemon";
      const session = sessionTag();
      if (announcing) {
        await be.call("announce", { status: "live", session }).catch(() => undefined);
      }
      const standDown = async (): Promise<void> => {
        // Names this session, so leaving takes only this one away. Another window
        // of the same agent still watching keeps the agent live.
        if (announcing)
          await be.call("announce", { status: "away", session }).catch(() => undefined);
      };

      // Blocking mode: return as soon as one matching item lands, or when the
      // bound expires. Exit 3 for the timeout so a caller can tell "nothing came"
      // from "the command failed" without parsing output.
      if (wait !== undefined) {
        const deadline = Date.now() + wait * 1000;
        while (matched === 0 && Date.now() < deadline) {
          await sleep(Math.min(interval * 1000, Math.max(0, deadline - Date.now())));
          if (matched > 0) break;
          await poll();
        }
        await standDown();
        if (matched === 0) {
          // `checked` is the difference between "the room is quiet" and "this
          // watcher never managed to look". Both produce no lines; only one of
          // them is evidence, and an agent that treats the second as the first
          // reports a colleague as silent while their message sits unfetched.
          out(
            `watch-timeout after=${String(wait)}s nothing matched` +
              ` checked=${confirmed ? "confirmed" : "UNCONFIRMED"}`,
          );
          return confirmed ? 3 : 4;
        }
        return 0;
      }

      // Chained timeout rather than an interval: a slow poll must not let the
      // next one stack up behind it.
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        // Clearing the timer is not enough on its own. A signal arriving while a
        // poll is in flight would still run the `.then(schedule)` below, arming a
        // fresh timer after this promise resolved — which keeps the event loop
        // alive past shutdown and then fires against a closed backend.
        let stopped = false;
        const stop = () => {
          stopped = true;
          clearTimeout(timer);
          resolve();
        };
        const schedule = () => {
          if (stopped) return;
          timer = setTimeout(() => {
            void poll().then(schedule);
          }, interval * 1000);
        };
        schedule();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      await standDown();
      return 0;
    },
    // A watcher keeps running, so it is a session in the sense the daemon
    // means: it publishes `live` on arrival and `away` on exit, once. `--once`
    // is a peek — it must not write a transition pair for a single poll.
    { session: !once },
  );
}

/**
 * Sanitise one field for an event line.
 *
 * Values reach a notification in an agent session, so they get the treatment
 * the daemon's notifier gives text bound for AppleScript: no control
 * characters, no newlines, bounded length. Ids and room names are
 * protocol-shaped, but "should be" is not a validation strategy for input that
 * arrived from another machine.
 */
function field(value: unknown, max: number): string {
  const text = String(value ?? "")
    // Stripping control characters is precisely the intent here: they arrive
    // inside text written on another machine, so the rule below is matching
    // them on purpose rather than assuming they will not be present.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text || "-";
}

function remember(seen: Set<string>, id: string): void {
  seen.add(id);
  if (seen.size <= WATCH_SEEN_CAP) return;
  // Set iteration is insertion-ordered, so this evicts oldest-first.
  let excess = seen.size - WATCH_SEEN_CAP;
  for (const key of seen) {
    seen.delete(key);
    if (--excess <= 0) break;
  }
}

async function cmdDaemon(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1] ?? "status";
  switch (sub) {
    case "status": {
      const status = await daemonStatus(ctx.layout);
      if (bool(ctx, "json")) {
        json(status);
        return status.running ? 0 : 1;
      }
      out(
        status.running
          ? green("● running") + dim(` · ${status.socket}`)
          : yellow("○ not running") + dim(` · ${status.socket}`),
      );
      out(
        `supervisor ${status.supervisor}${status.serviceInstalled ? green(" · unit installed") : dim(" · no unit")}`,
      );
      if (status.unit !== null) out(dim(`unit       ${status.unit}`));
      if (!status.running) {
        out();
        out(dim("start it:   komnet daemon start"));
        out(dim("or at login: komnet daemon install"));
      }
      return status.running ? 0 : 1;
    }
    case "start": {
      const result = await daemonStart(ctx.layout);
      out(result.started ? green(`✓ ${result.message}`) : yellow(result.message));
      return result.started || result.message === "already running" ? 0 : 1;
    }
    case "stop": {
      const result = await daemonStop(ctx.layout);
      out(result.stopped ? green(`✓ ${result.message}`) : yellow(result.message));
      return result.stopped || result.message === "not running" ? 0 : 1;
    }
    case "install": {
      for (const line of await daemonInstall()) out(line);
      return 0;
    }
    case "uninstall": {
      for (const line of await (await import("./daemon-cmd.ts")).daemonUninstall()) out(line);
      return 0;
    }
    case "run": {
      // Foreground: what the supervisor unit actually executes.
      const { Daemon } = await import("@komnet/daemon");
      const daemon = new Daemon({ layout: ctx.layout, log: (l) => errline(l) });
      await daemon.start();
      await new Promise<void>(() => {
        /* run until signalled */
      });
      return 0;
    }
    default:
      usage(`unknown 'daemon' subcommand: ${sub}`);
  }
}

/**
 * Provision and inspect the agent identities that live on this machine.
 *
 * Several agents on one machine is the ordinary case, not an exotic one: Claude
 * and Codex side by side, or two sessions of the same tool. They are separate
 * participants and each needs its own identity, because routing never returns a
 * message to its own author — so two tools sharing one agent id cannot reach
 * each other at all, and the failure is silent. Every message simply never
 * arrives.
 *
 * Each identity is a whole `KOMNET_HOME` of its own under `agents/<id>/`.
 */
async function cmdAgent(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1] ?? "list";
  const agentsRoot = join(ctx.layout.root, "agents");

  const provisioned = async (): Promise<{ id: string; home: string; network: string | null }[]> => {
    const { readdir } = await import("node:fs/promises");
    let entries: string[];
    try {
      entries = (await readdir(agentsRoot, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
    const rows: { id: string; home: string; network: string | null }[] = [];
    for (const id of entries) {
      const home = join(agentsRoot, id);
      const config = await loadConfig(new Layout(home).configPath).catch(() => null);
      rows.push({ id, home, network: config?.defaultNetwork ?? null });
    }
    return rows;
  };

  switch (sub) {
    case "add": {
      const id = ctx.positionals[2];
      if (id === undefined)
        usage("agent add needs an id: komnet agent add <agent-id> --repo <url>");
      assertAgentId(id);

      const home = ctx.layout.agentHomeDir(id);
      if (await pathExists(join(home, "config.yaml"))) {
        errline(red(`error: agent '${id}' already exists at ${home}`));
        errline(dim("  Use a distinct id for a second instance, e.g. " + `${id}-2`));
        return 1;
      }

      // `init` is the one command that must run inside the new home, so it is
      // re-entered as a child with KOMNET_HOME set rather than reimplemented.
      const remote = str(ctx, "repo");
      if (remote === undefined) {
        usage("agent add needs a transport: komnet agent add <agent-id> --repo <url-or-path>");
      }
      const network = str(ctx, "network");
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const self = process.argv[1];
      const argv = [
        ...(self === undefined ? [] : [self]),
        "init",
        "--repo",
        remote,
        "--agent",
        id,
        ...(network === undefined ? [] : ["--network", network]),
      ];
      try {
        await promisify(execFile)(process.execPath, argv, {
          env: { ...process.env, KOMNET_HOME: home },
        });
      } catch (error) {
        const e = error as { stderr?: string; stdout?: string };
        errline(red(`error: could not initialise agent '${id}'`));
        errline((e.stderr ?? e.stdout ?? String(error)).trim());
        return 1;
      }

      if (bool(ctx, "json")) {
        json({ id, home, network: network ?? null, remote });
        return 0;
      }
      out(green(`✓ agent ${bold(id)}`) + dim(` → ${home}`));
      out();
      out("point a tool at it:");
      out(`  ${bold(`komnet setup <tool> --agent ${id}`)}`);
      out("or run one command as this agent:");
      out(`  ${bold(`KOMNET_HOME=${home} komnet <command>`)}`);
      return 0;
    }

    case "list": {
      const rows = await provisioned();
      if (bool(ctx, "json")) {
        json(rows);
        return 0;
      }
      if (rows.length === 0) {
        out(dim("no per-agent homes on this machine"));
        out();
        out(dim("this machine's single shared identity is in " + ctx.layout.configPath));
        out(dim("add a second agent with: komnet agent add <id> --repo <transport>"));
        return 0;
      }
      for (const row of rows) {
        out(`${bold(row.id.padEnd(24))} ${dim(`${row.network ?? "unconfigured"} · ${row.home}`)}`);
      }
      return 0;
    }

    case "path": {
      const id = ctx.positionals[2];
      if (id === undefined) usage("agent path needs an id: komnet agent path <agent-id>");
      assertAgentId(id);
      // Bare, on stdout, so it composes: KOMNET_HOME=$(komnet agent path x) komnet inbox
      out(ctx.layout.agentHomeDir(id));
      return 0;
    }

    default:
      usage(`unknown 'agent' subcommand: ${sub}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  const { access } = await import("node:fs/promises");
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function cmdSetup(ctx: Ctx): Promise<number> {
  const target = ctx.positionals[1] as SetupTarget | undefined;
  if (target === undefined || !SETUP_TARGETS.includes(target)) {
    usage(`setup needs a tool: ${SETUP_TARGETS.join(" | ")}`);
  }

  const agent = str(ctx, "agent");
  if (agent !== undefined) assertAgentId(agent);
  const agentHome = agent === undefined ? undefined : ctx.layout.agentHomeDir(agent);
  if (agentHome !== undefined && !(await pathExists(join(agentHome, "config.yaml")))) {
    errline(red(`error: no agent '${agent ?? ""}' on this machine`));
    errline(dim(`  create it first: komnet agent add ${agent ?? "<id>"} --repo <transport>`));
    return 1;
  }

  const result = await setupTool(target, agentHome === undefined ? {} : { agentHome });
  if (bool(ctx, "json")) {
    json(result);
    return 0;
  }
  out(`${bold(target)}`);
  for (const change of result.changes) {
    const mark = change.action === "unchanged" ? dim("=") : green("✓");
    out(`${mark} ${change.what} ${dim(`→ ${change.path} (${change.action})`)}`);
  }
  out();
  // Before the notes, and not dimmed: this one is the difference between a
  // working link and two agents talking past each other in total silence.
  for (const warning of result.warnings) {
    out(`${yellow("!")} ${warning}`);
    out();
  }
  for (const note of result.notes) out(dim(`  ${note}`));
  return 0;
}

/** Diagnose the predictable failures, each with a concrete fix. */
/**
 * Check that this agent has said what it is for.
 *
 * Reported by doctor rather than enforced at init, because a blank card breaks
 * nothing mechanically — it breaks the one question komnet exists to answer,
 * and it does it silently. An agent whose card says `expertise: []` is
 * unfindable: a peer asking "who owns auth?" gets nobody, routes to a human,
 * and concludes the directory is empty rather than unfilled.
 */
async function describeOwnCard(
  ctx: Ctx,
  ok: (m: string) => void,
  warn: (m: string, hint: string) => void,
): Promise<void> {
  for (const netConfig of Object.values(ctx.config.networks)) {
    const network = Network.open(ctx.layout, netConfig, ctx.config.agent);
    try {
      const self = (await network.listAgents()).find((card) => card.id === ctx.config.agent.id);
      const profile = await network.getAgentProfile().catch(() => null);
      // The default profile is boilerplate true of any agent, so a card that
      // still carries it has said nothing — and reporting that as healthy is
      // what let a whole network of blank entries look like a directory.
      const described =
        (self?.expertise.length ?? 0) > 0 ||
        (self?.speaksFor.length ?? 0) > 0 ||
        (profile !== null && !isDefaultProfile(profile, ctx.config.agent));
      if (described) {
        ok(`${netConfig.id}: this agent's card says what it is for`);
      } else {
        warn(
          `${netConfig.id}: this agent's card is blank — peers cannot tell what you cover`,
          "komnet's premise is 'ask the agent that owns that repo', and an empty card answers nobody. Fill it in:\n" +
            "  komnet profile update --role '<what you do>' --responsibility '<repo or domain you own>'",
        );
      }
    } catch {
      // A network that will not open is already reported by the checks above.
    } finally {
      network.close();
    }
  }
}

async function cmdDoctor(ctx: Ctx): Promise<number> {
  let problems = 0;
  const ok = (m: string) => out(`${green("✓")} ${m}`);
  const warn = (m: string, hint: string) => {
    out(`${yellow("!")} ${m}`);
    out(dim(`  ${hint}`));
  };
  const bad = (m: string, fix: string) => {
    problems += 1;
    out(`${red("✗")} ${m}`);
    out(dim(`  fix: ${fix}`));
  };

  const runner = new GitRunner();
  try {
    const version = await new Repo(process.cwd(), runner).version();
    if (version.major > 2 || (version.major === 2 && version.minor >= 42)) {
      ok(`git ${version.major}.${version.minor}`);
    } else {
      bad(`git ${version.raw} is too old`, "komnet needs git 2.42+ (for 'worktree add --orphan')");
    }
  } catch {
    bad("git not found", "install git");
  }

  const networks = Object.keys(ctx.config.networks);
  if (networks.length === 0) {
    bad("no networks configured", "komnet init --repo <url>");
  } else {
    ok(`config at ${ctx.layout.configPath} (${String(networks.length)} network(s))`);
  }

  for (const netConfig of Object.values(ctx.config.networks)) {
    const repo = new Repo(ctx.layout.gitDir(netConfig.id), runner);
    // Three probes, not one.
    //
    // A single probe answers "did this one command work", and doctor reported
    // `✓ remote reachable` during a session where pushes were failing two times
    // in three — because intermittent auth (an SSH agent dropping a key, a
    // rate-limited host, a flapping VPN) walks straight past one attempt. An
    // intermittent transport is a different fault from a broken one, and it is
    // the one that makes people distrust the tool instead of the network.
    const attempts: string[] = [];
    let reached = 0;
    let rooms = 0;
    for (let probe = 0; probe < 3; probe += 1) {
      try {
        rooms = (await repo.lsRemoteRooms(netConfig.remote)).size;
        reached += 1;
      } catch (error) {
        attempts.push(conciseGitFailure(error));
      }
    }
    const where = `${netConfig.id} → ${netConfig.remote}`;
    if (reached === 3) {
      ok(`${where}: reachable (3/3), ${String(rooms)} room branch(es)`);
    } else if (reached > 0) {
      warn(
        `${where}: INTERMITTENT — reachable ${String(reached)}/3`,
        `failing probes said: ${[...new Set(attempts)].join(" · ")}\n` +
          "  messages still queue locally and go out on a later sync (komnet status shows the queue)",
      );
    } else {
      bad(
        `${where}: unreachable (0/3) — ${[...new Set(attempts)].join(" · ")}`,
        /permission|publickey|authentication/i.test(attempts.join(" "))
          ? `git asked for credentials it did not get. Check the identity this remote uses:\n` +
              `       ssh -T ${sshHostOf(netConfig.remote) ?? "git@<host>"}   ·   ssh-add -l`
          : "check the URL and your network",
      );
    }
    for (const roomId of netConfig.subscriptions) {
      const worktree = ctx.layout.roomWorktree(netConfig.id, roomId);
      try {
        await repo.runner.run(["rev-parse", "--is-inside-work-tree"], { cwd: worktree });
        ok(`${netConfig.id}/${roomId}: worktree healthy`);
      } catch {
        bad(`${netConfig.id}/${roomId}: worktree missing or broken`, `komnet room join ${roomId}`);
      }
    }
  }

  // A network of blank cards is a directory with no entries.
  //
  // komnet's premise is "ask the agent that owns that repo" — and the very
  // first question a new user asks is who owns what. Nothing at init fills the
  // card in, so the default state of a fresh network is one where the feature
  // that justifies the tool silently does not work: every card reads
  // `expertise: []`, and the answer has to be routed to a human anyway.
  await describeOwnCard(ctx, ok, warn);

  if (await DaemonClient.isAlive(ctx.layout.socketPath)) {
    ok("daemon running — messages arrive continuously");
  } else {
    // Whether this is a warning or a fault depends on something doctor did not
    // used to check: that `komnet daemon start` can actually launch anything.
    // Printing "start it with …" next to "no problems found", when that command
    // is guaranteed to fail, reads as a working instruction and sends people
    // looking for the fault in their own configuration.
    const entryProblem = await daemonEntryProblem();
    if (entryProblem === null) {
      // Not an error: direct mode works. But it changes the delivery model, so
      // say what is actually lost rather than just flagging it.
      warn(
        "daemon not running",
        "nothing accumulates while your agent is closed and no notifications fire; start it with 'komnet daemon start'",
      );
    } else {
      bad(
        `daemon cannot be launched — ${entryProblem}`,
        "reinstall komnet (curl -fsSL https://github.com/Komdosh/komnet/releases/latest/download/install.sh | bash), " +
          "or run 'komnet daemon run' in a terminal to host it in the foreground",
      );
    }
  }

  out();
  out(problems === 0 ? green("no problems found") : red(`${String(problems)} problem(s) found`));
  return problems === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- entrypoint

export async function run(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        repo: { type: "string" },
        network: { type: "string" },
        agent: { type: "string" },
        needs: { type: "string" },
        mention: { type: "string", multiple: true },
        // Repeatable, because a message may address several computers. `task
        // create` takes only one and says so rather than silently using a
        // value the caller did not mean.
        machine: { type: "string", multiple: true },
        tag: { type: "string", multiple: true },
        priority: { type: "string" },
        kind: { type: "string" },
        "reply-to": { type: "string" },
        "force-unsafe": { type: "string" },
        "as-human": { type: "boolean" },
        limit: { type: "string" },
        thread: { type: "string" },
        since: { type: "string" },
        room: { type: "string" },
        reviewer: { type: "string" },
        base: { type: "string" },
        head: { type: "string" },
        scope: { type: "string", multiple: true },
        ref: { type: "string", multiple: true },
        "fetch-remote": { type: "string" },
        "max-prepared": { type: "string" },
        "reply-budget": { type: "string" },
        deadline: { type: "string" },
        target: { type: "string" },
        "stale-after": { type: "string" },
        free: { type: "boolean" },
        mine: { type: "boolean" },
        ttl: { type: "string" },
        init: { type: "boolean" },
        revoke: { type: "boolean" },
        title: { type: "string" },
        purpose: { type: "string" },
        peer: { type: "string", multiple: true },
        role: { type: "string" },
        mission: { type: "string" },
        focus: { type: "string" },
        workspace: { type: "string" },
        capability: { type: "string", multiple: true },
        responsibility: { type: "string", multiple: true },
        constraint: { type: "string", multiple: true },
        "help-with": { type: "string", multiple: true },
        interval: { type: "string" },
        wait: { type: "string" },
        once: { type: "boolean" },
        "new-only": { type: "boolean" },
        "all-networks": { type: "boolean" },
        live: { type: "boolean" },
        away: { type: "boolean" },
        drain: { type: "boolean" },
        check: { type: "boolean" },
        direct: { type: "boolean" },
        json: { type: "boolean" },
        brief: { type: "boolean" },
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    errline(red(`error: ${describeError(error)}`));
    errline("Run 'komnet --help' for usage.");
    return 2;
  }

  const layout = new Layout();
  const ctx: Ctx = {
    layout,
    config: await loadOrEmpty(layout),
    values: parsed.values as Record<string, unknown>,
    positionals: parsed.positionals,
  };

  if (bool(ctx, "version")) {
    out(VERSION);
    return 0;
  }
  const command = ctx.positionals[0];
  if (command === undefined || bool(ctx, "help") || command === "help") {
    process.stdout.write(HELP);
    return command === undefined && !bool(ctx, "help") ? 2 : 0;
  }

  try {
    // Settle WHO this invocation is before it can write anything. `init`,
    // `agent`, and `setup` are excluded because they create and point at
    // identities — re-homing them would make provisioning impossible.
    if (!IDENTITY_NEUTRAL_COMMANDS.has(command)) {
      const resolved = await resolveIdentity(ctx, command);
      ctx.layout = resolved.layout;
      ctx.config = resolved.config;
    }

    switch (command) {
      case "init":
        return await cmdInit(ctx);
      case "setup":
        return await cmdSetup(ctx);
      case "agent":
        return await cmdAgent(ctx);
      case "room":
        return await cmdRoom(ctx);
      case "repo":
        return await cmdRepo(ctx);
      case "send":
        return await cmdSend(ctx, false);
      case "ask":
        return await cmdSend(ctx, true);
      case "answer":
        return await cmdAnswer(ctx);
      case "decide":
        return await cmdDecide(ctx);
      case "review":
        return await cmdReview(ctx);
      case "task":
        return await cmdTask(ctx);
      case "read":
        return await cmdRead(ctx);
      case "history":
        return await cmdHistory(ctx);
      case "search":
        return await cmdSearch(ctx);
      case "inbox":
        return await cmdInbox(ctx);
      case "handshake":
        return await cmdHandshake(ctx);
      case "watch":
        return await cmdWatch(ctx);
      case "network":
        return await cmdNetwork(ctx);
      case "trace":
        return await cmdTrace(ctx);
      case "receipts":
        return await cmdReceipts(ctx);
      case "mentions":
        return await cmdMentions(ctx);
      case "sync":
        return await cmdSync(ctx);
      case "seal":
        return await cmdSeal(ctx);
      case "status":
        return await cmdStatus(ctx);
      case "agents":
        return await cmdAgents(ctx);
      case "machine":
        return await cmdMachine(ctx);
      case "machines":
        return await cmdMachines(ctx);
      case "peers":
        return await cmdPeers(ctx);
      case "profile":
        return await cmdProfile(ctx);
      case "presence":
        return await cmdPresence(ctx);
      case "claim":
        return await cmdClaim(ctx);
      case "claims":
        return await cmdClaims(ctx);
      case "policy":
        return await cmdPolicy(ctx);
      case "approvals":
        return await cmdApprovals(ctx);
      case "daemon":
        return await cmdDaemon(ctx);
      case "mcp": {
        const { runStdioServer } = await import("@komnet/mcp");
        const network = str(ctx, "network");
        await runStdioServer({
          ...(network === undefined ? {} : { network }),
          ...(bool(ctx, "direct") ? { direct: true } : {}),
        });
        return 0;
      }
      case "doctor":
        return await cmdDoctor(ctx);
      default:
        errline(red(`error: unknown command '${command}'`));
        errline("Run 'komnet --help' for usage.");
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) return 2;

    // The scanner block must read the same whether it came from this process or
    // across the socket, where only message and code survive.
    const code = (error as { code?: unknown } | null)?.code;

    // A daemon started before this CLI was installed does not know its newer
    // IPC methods. Untranslated, that surfaces as "unknown method handshake",
    // which reads like a typo in the command rather than a stale process.
    if (code === "UNKNOWN_METHOD") {
      errline(red("✗ the running komnet daemon is older than this CLI"));
      errline("  It does not know this command yet. Restart it:");
      errline(dim("    komnet daemon stop && komnet daemon start"));
      errline("");
      errline(dim("  Or run this one command without it: --direct"));
      return 1;
    }
    // Exit 4, distinct from a generic failure: an agent driving the CLI must be
    // able to tell "your human has to see this" from "the command was wrong",
    // without parsing prose.
    if (
      error instanceof IdentityMismatchError ||
      error instanceof AmbiguousIdentityError ||
      code === "IDENTITY_MISMATCH" ||
      code === "AMBIGUOUS_IDENTITY"
    ) {
      errline(red("✗ refusing to act as an identity that was not asserted"));
      if (error instanceof Error) errline(`  ${error.message}`);
      errline("");
      errline(dim("  who this machine holds:  komnet agent list"));
      errline(dim("  who you would be here:   komnet status"));
      return 6;
    }
    if (error instanceof ApprovalRequiredError || code === "APPROVAL_REQUIRED") {
      errline(yellow("✗ this work needs a person's approval before you take it on"));
      if (error instanceof Error) errline(`  ${error.message}`);
      errline("");
      errline("Show your human who is asking and what the work touches. If they agree:");
      errline(
        dim(
          error instanceof ApprovalRequiredError
            ? `  komnet ${error.kind} approve ${error.room} ${error.id}`
            : "  komnet task approve <room> <id>",
        ),
      );
      errline(dim("Current rules: komnet policy"));
      return 4;
    }
    if (error instanceof SecretDetectedError || code === "SECRET_DETECTED") {
      errline(red("✗ refused to send — possible secret detected"));
      if (error instanceof SecretDetectedError) {
        errline(`  ${describeFindings(error.findings)}`);
      } else if (error instanceof Error) {
        errline(`  ${error.message}`);
      }
      errline("");
      errline("Git history is permanent: a leaked credential can only be rotated, not recalled.");
      errline("Remove it, or if this is a false positive:");
      errline(dim("  komnet send ... --force-unsafe '<why this is safe>'"));
      return 1;
    }

    errline(red(`error: ${describeError(error)}`));
    return 1;
  }
}
