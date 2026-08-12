import { parseArgs } from "node:util";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  GitRunner,
  Layout,
  Network,
  Repo,
  ReviewRepositoryResolver,
  SecretDetectedError,
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
  type ReviewTaskStatus,
  type TaskStatus,
} from "@komnet/core";
import { DaemonClient, openBackend, type Backend } from "@komnet/daemon";
import {
  REVIEW_TASK_STATES,
  TASK_UPDATE_ACTIONS,
  ulid,
  assertAgentId,
  assertCanonicalRepositoryId,
  assertRoomId,
  isReviewTaskState,
  isTaskUpdateAction,
  slugify,
  type Message,
} from "@komnet/protocol";

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
  renderInbox,
  renderInboxBrief,
  renderMessages,
  yellow,
} from "./output.ts";
import { SETUP_TARGETS, setupTool, type SetupTarget } from "./setup.ts";

export const VERSION = "0.2.0";

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
  receipts <room>              who has read what; --reply-to <id> marks who read it
  mentions                     messages naming you in rooms you have not joined

REVIEWS
  review request <room> <text> create a targeted review (--reviewer, --repo, --base, --head)
  review update <room> <id> <state> <text>
                               append a guarded lifecycle transition
  review prepare <room> <id>   resolve and detach the exact local review revision
  review release <id>          remove a prepared review worktree if it is clean
  review list <room>           current review tasks and lifecycle state

TASKS
  task create <room> <text>    create targeted/free work (--title, --target, --stale-after)
  task claim <room> <id> <text> publish that this agent accepts the task
  task update <room> <id> <action> <text>
                               refine or advance a guarded task lifecycle
  task list <room>             assignment, state, stale health, and conflicts

FIRST CONTACT
  handshake <room> [note]      announce this agent live and greet the room
  handshake ack <id> [note]    answer a handshake; confirms the link both ways
  watch                        stream inbox events, one metadata line each

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
  --tag <tag>                  tag a message (repeatable)
  --priority low|normal|high|blocking
  --kind msg|question|answer|decision|status|artifact
  --reply-to <message-id>      thread this under an existing message
  --scope <path>               repository-review scope (repeatable)
  --ref <repo@rev:path>        repository-review code reference (repeatable)
  --target <agent>             task target; omit on create for free-to-claim
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
  --wait <seconds>             'watch': block until one match arrives; exit 3 on timeout
  --direct                     bypass the daemon and open the network in-process
  --version, --help

NOTES
  Everything you send is permanent and visible to everyone with repo access.
  'needs: human' is a cooperative workflow signal. Direct agent/MCP answers are
  refused, but --as-human attribution is not strict proof of human presence.
  Commands run through the daemon when it is up, and directly otherwise.
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
 */
async function withBackend(ctx: Ctx, fn: (backend: Backend) => Promise<number>): Promise<number> {
  const network = str(ctx, "network");
  const backend = await openBackend({
    layout: ctx.layout,
    ...(network === undefined ? {} : { network }),
    ...(bool(ctx, "direct") ? { forceDirect: true } : {}),
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

    out(green(createdNetwork ? "✓ initialised a new network" : "✓ joined existing network"));
    out(`✓ agent card published as ${ctx.config.agent.id}`);
    out(`✓ config written to ${ctx.layout.configPath}`);
    out();
    out(
      `Next:  ${cyan("komnet room list")}   ${dim("·")}   ${cyan("komnet daemon start")}   ${dim("·")}   ${cyan("komnet setup claude-code")}`,
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
  const mentions = list(ctx, "mention");
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
    if (bool(ctx, "json")) {
      json(messageToJson(message));
      return 0;
    }
    out(green("✓ sent") + dim(` ${message.header.id}`));
    if (message.header.needs === "human") {
      out(dim("  parked — surface this to a human; relay attribution is cooperative."));
    }
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
    out(green("✓ decision recorded") + dim(` ${message.header.id}`));
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
    if (bool(ctx, "json")) json(messageToJson(message));
    else out(green("✓ answered") + dim(` ${message.header.id}`));
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
    usage("review needs a subcommand: request, update, prepare, release, or list");
  }

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
        usage("unknown review subcommand; use request, update, prepare, release, or list");
    }
  });
}

async function cmdTask(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1];
  if (sub === undefined) usage("task needs a subcommand: create, claim, update, or list");
  const room = ctx.positionals[2];
  if (room === undefined) usage("task needs a room: task create|claim|update|list <room>");
  assertRoomId(room);

  return await withBackend(ctx, async (be) => {
    switch (sub) {
      case "create": {
        const definition = ctx.positionals.slice(3).join(" ");
        const title = str(ctx, "title");
        if (title === undefined || definition === "") {
          usage("task create needs <room> <text> --title <one-line title>");
        }
        const target = str(ctx, "target");
        if (target !== undefined) assertAgentId(target);
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
          out(dim(`  ${target === undefined ? "free to claim" : `target → ${target}`}`));
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
        const target = str(ctx, "target");
        if (target !== undefined) assertAgentId(target);
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
        usage("unknown task subcommand; use create, claim, update, or list");
    }
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

async function cmdInbox(ctx: Ctx): Promise<number> {
  const room = str(ctx, "room");
  const needs = str(ctx, "needs");
  const tag = list(ctx, "tag")[0];

  return await withBackend(ctx, async (be) => {
    const items = await be.call<InboxRow[]>("inbox", {
      ...(room === undefined ? {} : { room }),
      ...(needs === undefined ? {} : { needs }),
      ...(tag === undefined ? {} : { tag }),
    });

    if (bool(ctx, "drain")) {
      const result = await be.call<{ drained: number; refused: string[] }>("inboxDrain", {
        ids: items.map((i) => i.id),
        rooms: [...new Set(items.map((i) => i.room))],
      });
      if (bool(ctx, "json")) {
        json({
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

    if (bool(ctx, "json")) json(items);
    else if (bool(ctx, "brief")) renderInboxBrief(items);
    else renderInbox(items);
    return 0;
  });
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
      daemon?: { sessionLive: boolean; cadence: string; sessions: number };
    }>("status");
    if (bool(ctx, "json")) {
      json({ ...status, mode: be.mode });
      return 0;
    }
    out(`${bold(status.networkId)} ${dim(status.remote)}`);
    out(`agent      ${status.agentId}`);
    out(`rooms      ${status.subscriptions.join(", ") || dim("none")}`);
    out(
      `pending    ${String(status.pending)}${
        status.pendingHuman > 0 ? red(` (${String(status.pendingHuman)} need a human)`) : ""
      }`,
    );
    out(`last sync  ${status.lastSyncAt === null ? dim("never") : ago(status.lastSyncAt)}`);
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
        // after this command keeps the assertion true.
        out(dim("  this says a session announced itself now; it goes stale in 15m"));
      }
      return 0;
    }

    const rows = await be.call<
      {
        id: string;
        status: string;
        lastSeen: string;
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
      out(
        `${mark}${concurrent}  ${bold(r.id.padEnd(20))} ` +
          dim(`${ago(r.lastSeen)} · ${r.human} · ${r.timezone}`),
      );
    }
    if (be.mode !== "daemon") {
      out();
      out(
        dim(
          "no daemon: presence is published by 'komnet watch' and 'komnet handshake' while they run,\n" +
            "and decays to stale after 15m. For continuous presence: komnet daemon start",
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
      `presence   ${report.presencePublished ? green("published live") : dim("already live")}` +
        (be.mode === "daemon" ? "" : yellow(" · no daemon: it goes stale in 15m")),
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
 */
async function cmdWatch(ctx: Ctx): Promise<number> {
  const room = str(ctx, "room");
  const thread = str(ctx, "thread");
  const tag = list(ctx, "tag")[0];
  const needs = str(ctx, "needs");
  const once = bool(ctx, "once");
  const wait = num(ctx, "wait");
  const interval = Math.max(WATCH_MIN_INTERVAL_S, num(ctx, "interval") ?? WATCH_DEFAULT_INTERVAL_S);

  return await withBackend(ctx, async (be) => {
    const seen = new Set<string>();
    let consecutiveFailures = 0;
    let announcedFailure = false;
    // `--wait` turns the stream into a single blocking question: "tell me when
    // one matching thing arrives". An agent turn cannot spin, so without this
    // the only options were to burn turns polling or hand back to the human.
    let matched = 0;

    const poll = async (): Promise<void> => {
      try {
        // In direct mode nothing else is pulling, so the watcher has to. With a
        // daemon, `withBackend` has already opened a session — which puts the
        // daemon in its hot cadence and publishes this agent as live — so
        // forcing a sync here would only fight that cadence.
        if (be.mode !== "daemon") await be.call("sync");

        const items = await be.call<InboxRow[]>("inbox", {
          ...(room === undefined ? {} : { room }),
          ...(needs === undefined ? {} : { needs }),
          ...(tag === undefined ? {} : { tag }),
        });

        if (announcedFailure) out("watch-recovered komnet reachable again");
        consecutiveFailures = 0;
        announcedFailure = false;

        for (const item of items) {
          if (seen.has(item.id)) continue;
          remember(seen, item.id);
          if (thread !== undefined && item.thread !== thread) continue;
          matched += 1;
          out(
            `komnet-inbox id=${field(item.id, 40)} room=${field(item.room, 60)}` +
              ` from=${field(item.from, 60)} needs=${field(item.needs, 12)}` +
              ` priority=${field(item.priority, 12)} kind=${field(item.kind, 16)}` +
              ` thread=${field(item.thread, 40)} tags=${field((item.tags ?? []).join(","), 80)}`,
          );
        }
      } catch (error) {
        consecutiveFailures += 1;
        // One line after a sustained outage, then silence until it recovers:
        // enough for the agent to notice and run `komnet doctor`, not enough to
        // flood a session while a laptop is asleep.
        if (consecutiveFailures >= 3 && !announcedFailure) {
          announcedFailure = true;
          out(
            `watch-degraded consecutive-failures=${String(consecutiveFailures)}` +
              ` reason=${field(error instanceof Error ? error.message : String(error), 120)}`,
          );
        }
      }
    };

    const filters = [
      room === undefined ? null : `room:${room}`,
      thread === undefined ? null : `thread:${thread}`,
      tag === undefined ? null : `tag:${tag}`,
      needs === undefined ? null : `needs:${needs}`,
    ].filter((f) => f !== null);
    out(
      `watch-armed poll=${String(interval)}s mode=${be.mode}` +
        ` sync=${be.mode === "daemon" ? "daemon" : "self"}` +
        `${wait === undefined ? "" : ` wait=${String(wait)}s`}` +
        ` filter=${filters.length === 0 ? "none" : filters.join(",")}`,
    );

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
      if (announcing) await be.call("announce", { status: "away", session }).catch(() => undefined);
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
        out(`watch-timeout after=${String(wait)}s nothing matched`);
        return 3;
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
  });
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
  for (const note of result.notes) out(dim(`  ${note}`));
  return 0;
}

/** Diagnose the predictable failures, each with a concrete fix. */
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
    try {
      const heads = await repo.lsRemoteRooms(netConfig.remote);
      ok(`${netConfig.id}: remote reachable, ${String(heads.size)} room branch(es)`);
    } catch (error) {
      bad(
        `${netConfig.id}: cannot reach ${netConfig.remote}`,
        error instanceof Error && /permission|authentication/i.test(error.message)
          ? "check your git credentials / SSH agent"
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
    errline(red(`error: ${error instanceof Error ? error.message : String(error)}`));
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
      case "profile":
        return await cmdProfile(ctx);
      case "presence":
        return await cmdPresence(ctx);
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

    errline(red(`error: ${error instanceof Error ? error.message : String(error)}`));
    return 1;
  }
}
