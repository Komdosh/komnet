import { parseArgs } from "node:util";
import { realpath } from "node:fs/promises";

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
} from "@komnet/core";
import { DaemonClient, openBackend, type Backend } from "@komnet/daemon";
import {
  REVIEW_TASK_STATES,
  assertAgentId,
  assertCanonicalRepositoryId,
  assertRoomId,
  isReviewTaskState,
  slugify,
  type Message,
} from "@komnet/protocol";

import { daemonInstall, daemonStart, daemonStatus, daemonStop } from "./daemon-cmd.ts";
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

export const VERSION = "0.1.2";

const HELP = `komnet ${VERSION} — a message tunnel for AI coding agents over a git repository you own.

USAGE
  komnet <command> [options]

SETUP
  init --repo <url>            clone/adopt a transport repo and register this agent
  setup <tool>                 wire up claude-code | claude-desktop | cursor | codex
  doctor                       diagnose git, config, remote access, worktrees, daemon

ROOMS
  room list                    rooms on the network, with unread counts
  room create <id>             create a room (--title, --purpose)
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
  ask <room> <question>        ask; --needs human parks the thread for a person
  answer <message-id> <text>   answer a message; --as-human to record a human decision
  read <room>                  read the live window (--limit, --thread)
  history <room>               read past the window, from git history (--since)
  search <query>               search the live window of subscribed rooms (--room)
  inbox                        pending messages (--drain, --room, --needs, --brief)

REVIEWS
  review request <room> <text> create a targeted review (--reviewer, --repo, --base, --head)
  review update <room> <id> <state> <text>
                               append a guarded lifecycle transition
  review prepare <room> <id>   resolve and detach the exact local review revision
  review release <id>          remove a prepared review worktree if it is clean
  review list <room>           current review tasks and lifecycle state

NETWORK
  sync                         poll the remote and deliver new messages
  seal <room>                  compact a room: merge to main, digest, prune (--check)
  status                       sync freshness, pending counts, subscriptions
  agents                       who is on this network
  presence                     whose agent session is live right now

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
  --fetch-remote <name>        allow a mapped local git remote to fetch missing objects
  --force-unsafe <reason>      override a secret-scanner block; the reason is permanent
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
        await be.call("roomCreate", {
          room: roomId,
          ...(title === undefined ? {} : { title }),
          ...(purpose === undefined ? {} : { purpose }),
        });
        out(green(`✓ created room ${roomId} and subscribed`));
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

  const needs = str(ctx, "needs") ?? (asQuestion ? "human" : "none");
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
  path: string;
  body: string;
  processedAt: string | null;
}

async function cmdInbox(ctx: Ctx): Promise<number> {
  const room = str(ctx, "room");
  const needs = str(ctx, "needs");

  return await withBackend(ctx, async (be) => {
    const items = await be.call<InboxRow[]>("inbox", {
      ...(room === undefined ? {} : { room }),
      ...(needs === undefined ? {} : { needs }),
    });

    if (bool(ctx, "drain")) {
      const result = await be.call<{ drained: number; refused: string[] }>("inboxDrain", {
        ids: items.map((i) => i.id),
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
    const cards =
      await be.call<{ id: string; human: { name: string; timezone: string }; tool: string }[]>(
        "agents",
      );
    if (bool(ctx, "json")) {
      json(cards);
      return 0;
    }
    if (cards.length === 0) {
      out(dim("no agents registered"));
      return 0;
    }
    for (const c of cards) {
      out(`${bold(c.id.padEnd(20))} ${dim(`${c.human.name} · ${c.human.timezone} · ${c.tool}`)}`);
    }
    return 0;
  });
}

async function cmdPresence(ctx: Ctx): Promise<number> {
  return await withBackend(ctx, async (be) => {
    const rows =
      await be.call<
        { id: string; status: string; lastSeen: string; human: string; timezone: string }[]
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
      out(
        `${mark}  ${bold(r.id.padEnd(20))} ${dim(`${ago(r.lastSeen)} · ${r.human} · ${r.timezone}`)}`,
      );
    }
    if (be.mode !== "daemon") {
      out();
      out(dim("presence is published by the daemon; start it with: komnet daemon start"));
    }
    return 0;
  });
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

async function cmdSetup(ctx: Ctx): Promise<number> {
  const target = ctx.positionals[1] as SetupTarget | undefined;
  if (target === undefined || !SETUP_TARGETS.includes(target)) {
    usage(`setup needs a tool: ${SETUP_TARGETS.join(" | ")}`);
  }

  const result = await setupTool(target);
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
    // Not an error: direct mode works. But it changes the delivery model, so
    // say what is actually lost rather than just flagging it.
    warn(
      "daemon not running",
      "nothing accumulates while your agent is closed and no notifications fire; start it with 'komnet daemon start'",
    );
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
        deadline: { type: "string" },
        title: { type: "string" },
        purpose: { type: "string" },
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
      case "review":
        return await cmdReview(ctx);
      case "read":
        return await cmdRead(ctx);
      case "history":
        return await cmdHistory(ctx);
      case "search":
        return await cmdSearch(ctx);
      case "inbox":
        return await cmdInbox(ctx);
      case "sync":
        return await cmdSync(ctx);
      case "seal":
        return await cmdSeal(ctx);
      case "status":
        return await cmdStatus(ctx);
      case "agents":
        return await cmdAgents(ctx);
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
