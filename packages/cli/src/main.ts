import { parseArgs } from "node:util";

import {
  FileLock,
  GitRunner,
  Layout,
  Network,
  Repo,
  SecretDetectedError,
  defaultIdentity,
  describeFindings,
  emptyConfig,
  loadConfig,
  resolveNetwork,
  saveConfig,
  type KomnetConfig,
  type NetworkConfig,
} from "@kom-net/core";
import { assertAgentId, assertRoomId, slugify } from "@kom-net/protocol";
import type { MessageKind, Needs, Priority } from "@kom-net/protocol";

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

export const VERSION = "0.1.0";

const HELP = `komnet ${VERSION} — a message tunnel for AI coding agents over a git repository you own.

USAGE
  komnet <command> [options]

SETUP
  init --repo <url>            clone/adopt a transport repo and register this agent
  doctor                       diagnose git, config, remote access, worktrees

ROOMS
  room list                    rooms on the network, with unread counts
  room create <id>             create a room (--title, --purpose)
  room join <id>               subscribe and materialise a room
  room leave <id>              unsubscribe and drop the local worktree
  room show <id>               room configuration

MESSAGING
  send <room> <text>           send a message
  ask <room> <question>        ask; --needs human parks the thread for a person
  answer <message-id> <text>   answer a message; --as-human to record a human decision
  read <room>                  read the live window (--limit, --thread)
  inbox                        pending messages (--drain, --room, --needs, --brief)

NETWORK
  sync                         poll the remote and deliver new messages
  status                       sync freshness, pending counts, subscriptions
  agents                       who is on this network

OPTIONS
  --json                       machine-readable output (on every read command)
  --network <id>               pick a network when several are configured
  --needs none|agent|human     who must act on this message
  --mention <agent>            route to an agent (repeatable); use @room for everyone
  --tag <tag>                  tag a message (repeatable)
  --priority low|normal|high|blocking
  --kind msg|question|answer|decision|status|artifact
  --reply-to <message-id>      thread this under an existing message
  --force-unsafe <reason>      override a secret-scanner block; the reason is permanent
  --version, --help

NOTES
  Everything you send is permanent and visible to everyone with repo access.
  A 'needs: human' message cannot be answered by an agent — that is enforced,
  not advisory.
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

function bool(ctx: Ctx, key: string): boolean {
  return ctx.values[key] === true;
}

function list(ctx: Ctx, key: string): string[] {
  const v = ctx.values[key];
  return Array.isArray(v) ? (v as string[]) : [];
}

function usage(message: string): never {
  errline(red(`error: ${message}`));
  errline("");
  errline("Run 'komnet --help' for usage.");
  throw new UsageError(message);
}

class UsageError extends Error {}

async function loadOrEmpty(layout: Layout): Promise<KomnetConfig> {
  return (await loadConfig(layout.configPath)) ?? emptyConfig(defaultIdentity());
}

/** Open the selected network, persist any subscription change, always close. */
async function withNetwork(
  ctx: Ctx,
  fn: (net: Network, netConfig: NetworkConfig) => Promise<number>,
): Promise<number> {
  const netConfig = resolveNetwork(ctx.config, str(ctx, "network"));
  const network = Network.open(ctx.layout, netConfig, ctx.config.agent);
  try {
    return await fn(network, netConfig);
  } finally {
    ctx.config.networks[netConfig.id] = netConfig;
    await saveConfig(ctx.layout.configPath, ctx.config);
    network.close();
  }
}

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
    out(`Next:  ${cyan("komnet room list")}   or   ${cyan("komnet room create <name>")}`);
    return 0;
  } finally {
    network.close();
  }
}

async function cmdRoom(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1] ?? "list";
  const roomId = ctx.positionals[2];

  return await withNetwork(ctx, async (net) => {
    switch (sub) {
      case "list": {
        const rooms = await net.listRooms();
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
        const created = await net.createRoom(roomId, {
          ...(str(ctx, "title") === undefined ? {} : { title: str(ctx, "title") as string }),
          ...(str(ctx, "purpose") === undefined ? {} : { purpose: str(ctx, "purpose") as string }),
        });
        out(green(`✓ created room ${created.id} and subscribed`));
        return 0;
      }
      case "join": {
        if (roomId === undefined) usage("room join needs a name");
        await net.joinRoom(assertRoomId(roomId));
        out(green(`✓ joined ${roomId}`));
        return 0;
      }
      case "leave": {
        if (roomId === undefined) usage("room leave needs a name");
        await net.leaveRoom(assertRoomId(roomId));
        out(green(`✓ left ${roomId}`));
        return 0;
      }
      case "show": {
        if (roomId === undefined) usage("room show needs a name");
        const room = await net.readRoomConfig(assertRoomId(roomId));
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

function sendInputFrom(ctx: Ctx, body: string, defaults: { kind: MessageKind; needs: Needs }) {
  const needs = (str(ctx, "needs") ?? defaults.needs) as Needs;
  const kind = (str(ctx, "kind") ?? defaults.kind) as MessageKind;
  const priority = str(ctx, "priority") as Priority | undefined;
  const mentions = list(ctx, "mention");
  const tags = list(ctx, "tag");
  const replyTo = str(ctx, "reply-to");
  const forceUnsafe = str(ctx, "force-unsafe");
  return {
    body,
    kind,
    needs,
    ...(mentions.length > 0 ? { mentions } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(priority === undefined ? {} : { priority }),
    ...(replyTo === undefined ? {} : { inReplyTo: replyTo }),
    ...(forceUnsafe === undefined ? {} : { forceUnsafe }),
  };
}

async function cmdSend(ctx: Ctx, asQuestion: boolean): Promise<number> {
  const roomId = ctx.positionals[1];
  const body = ctx.positionals.slice(2).join(" ");
  if (roomId === undefined || body === "") {
    usage(asQuestion ? "ask needs a room and a question" : "send needs a room and a message");
  }
  assertRoomId(roomId);

  return await withNetwork(ctx, async (net) => {
    const input = sendInputFrom(
      ctx,
      body,
      asQuestion ? { kind: "question", needs: "human" } : { kind: "msg", needs: "none" },
    );
    const message = await net.send(roomId, input);
    if (bool(ctx, "json")) {
      json(messageToJson(message));
      return 0;
    }
    out(green(`✓ sent`) + dim(` ${message.header.id}`));
    if (message.header.needs === "human") {
      out(dim("  parked — a human must answer this; agents cannot."));
    }
    return 0;
  });
}

async function cmdAnswer(ctx: Ctx): Promise<number> {
  const messageId = ctx.positionals[1];
  const body = ctx.positionals.slice(2).join(" ");
  if (messageId === undefined || body === "") usage("answer needs a message id and a reply");

  return await withNetwork(ctx, async (net) => {
    const message = await net.answer(messageId, body, bool(ctx, "as-human"));
    if (bool(ctx, "json")) json(messageToJson(message));
    else out(green("✓ answered") + dim(` ${message.header.id}`));
    return 0;
  });
}

async function cmdRead(ctx: Ctx): Promise<number> {
  const roomId = ctx.positionals[1];
  if (roomId === undefined) usage("read needs a room");
  assertRoomId(roomId);
  const limitRaw = str(ctx, "limit");
  const thread = str(ctx, "thread");

  return await withNetwork(ctx, async (net) => {
    const messages = await net.read(roomId, {
      ...(limitRaw === undefined ? { limit: 50 } : { limit: Number(limitRaw) }),
      ...(thread === undefined ? {} : { thread }),
    });
    if (bool(ctx, "json")) json(messages.map(messageToJson));
    else renderMessages(messages);
    return 0;
  });
}

async function cmdInbox(ctx: Ctx): Promise<number> {
  return await withNetwork(ctx, async (net) => {
    const room = str(ctx, "room");
    const needs = str(ctx, "needs");
    const items = net.inbox({
      ...(room === undefined ? {} : { room }),
      ...(needs === undefined ? {} : { needs }),
    });

    if (bool(ctx, "drain")) {
      const { drained, refused } = net.drainInbox(items.map((i) => i.id));
      const payload = {
        drained,
        messages: items.filter((i) => i.needs !== "human"),
        awaitingHuman: items.filter((i) => i.needs === "human"),
      };
      if (bool(ctx, "json")) json(payload);
      else {
        renderInbox(items);
        out();
        out(green(`✓ drained ${String(drained)}`));
        if (refused.length > 0) {
          out(
            red(
              `  ${String(refused.length)} left pending — 'needs: human' items require a person.`,
            ),
          );
        }
      }
      return 0;
    }

    await net.writeInboxFiles();
    if (bool(ctx, "json")) json(items);
    else if (bool(ctx, "brief")) renderInboxBrief(items);
    else renderInbox(items);
    return 0;
  });
}

async function cmdSync(ctx: Ctx): Promise<number> {
  return await withNetwork(ctx, async (net) => {
    const report = await net.sync();
    await net.writeInboxFiles();
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
  return await withNetwork(ctx, async (net) => {
    const status = await net.status();
    if (bool(ctx, "json")) {
      json(status);
      return 0;
    }
    out(`${bold(status.networkId)} ${dim(status.remote)}`);
    out(`agent      ${status.agentId}`);
    out(`rooms      ${status.subscriptions.join(", ") || dim("none")}`);
    out(
      `pending    ${String(status.pending)}${status.pendingHuman > 0 ? red(` (${String(status.pendingHuman)} need a human)`) : ""}`,
    );
    out(`last sync  ${status.lastSyncAt === null ? dim("never") : ago(status.lastSyncAt)}`);
    return 0;
  });
}

async function cmdAgents(ctx: Ctx): Promise<number> {
  return await withNetwork(ctx, async (net) => {
    const cards = await net.listAgents();
    if (bool(ctx, "json")) {
      json(cards);
      return 0;
    }
    if (cards.length === 0) {
      out(dim("no agents registered"));
      return 0;
    }
    for (const c of cards) {
      const live = c.presence.status === "live" ? green("● live") : dim("○ away");
      out(
        `${live}  ${bold(c.id.padEnd(20))} ${dim(`${c.human.name} · ${c.human.timezone} · ${c.tool}`)}`,
      );
    }
    return 0;
  });
}

/** Diagnose the predictable failures, each with a concrete fix. */
async function cmdDoctor(ctx: Ctx): Promise<number> {
  let problems = 0;
  const ok = (m: string) => out(`${green("✓")} ${m}`);
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
      bad(`git ${version.raw} is too old`, "kom-net needs git 2.42+ (for 'worktree add --orphan')");
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

  out();
  out(dim("daemon: not implemented yet — the CLI runs in direct mode (ADR 0005)."));
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
        room: { type: "string" },
        title: { type: "string" },
        purpose: { type: "string" },
        drain: { type: "boolean" },
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

  const ctx: Ctx = {
    layout: new Layout(),
    config: await loadOrEmpty(new Layout()),
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
      case "room":
        return await cmdRoom(ctx);
      case "send":
        return await cmdSend(ctx, false);
      case "ask":
        return await cmdSend(ctx, true);
      case "answer":
        return await cmdAnswer(ctx);
      case "read":
        return await cmdRead(ctx);
      case "inbox":
        return await cmdInbox(ctx);
      case "sync":
        return await cmdSync(ctx);
      case "status":
        return await cmdStatus(ctx);
      case "agents":
        return await cmdAgents(ctx);
      case "doctor":
        return await cmdDoctor(ctx);
      default:
        errline(red(`error: unknown command '${command}'`));
        errline("Run 'komnet --help' for usage.");
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) return 2;

    if (error instanceof SecretDetectedError) {
      // Report type and location; never the value.
      errline(red("✗ refused to send — possible secret detected"));
      errline(`  ${describeFindings(error.findings)}`);
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

export { FileLock };
