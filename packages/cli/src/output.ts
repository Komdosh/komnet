import type { Agenda, InboxItem, ResumePoint, TaskDetail, TaskHealth } from "@komnet/core";
import type { Message } from "@komnet/protocol";

/** Colour only when attached to a terminal, and never when NO_COLOR is set. */
const useColor =
  process.stdout.isTTY === true &&
  process.env["NO_COLOR"] === undefined &&
  process.env["TERM"] !== "dumb";

const wrap = (code: string) => (s: string) => (useColor ? `[${code}m${s}[0m` : s);

export const dim = wrap("2");
export const bold = wrap("1");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const cyan = wrap("36");

export function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export function errline(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Compact relative time — agents and humans both read this better than an ISO stamp. */
export function ago(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "?";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.round(hours / 24))}d ago`;
}

function needsBadge(needs: string): string {
  if (needs === "human") return red("needs:human");
  if (needs === "agent") return yellow("needs:agent");
  return dim("needs:none");
}

export function renderInbox(items: readonly InboxItem[]): void {
  if (items.length === 0) {
    out(dim("inbox empty"));
    return;
  }
  for (const item of items) {
    out(
      `${cyan(item.room.padEnd(16))} ${bold(item.from.padEnd(18))} ${needsBadge(item.needs)}  ${firstLine(item.body, 68)}`,
    );
    out(`${dim(`  ${item.id}  ${ago(item.ts)}`)}`);
  }
  out();
  const human = items.filter((i) => i.needs === "human").length;
  out(
    human > 0
      ? `${String(items.length)} pending · ${red(`${String(human)} awaiting a human decision`)}`
      : `${String(items.length)} pending`,
  );
}

function firstLine(body: string, max: number): string {
  const first = body.trim().split("\n")[0] ?? "";
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/**
 * The session-start brief: work in hand first, then mail.
 *
 * The order is the point. This is the one unasked push komnet gets (ADR 0017),
 * so it sets what the session anchors on for the whole of its life — and a
 * brief that opens with other agents' questions anchors it on other agents'
 * priorities. Long work that outlived the last session is the thing most likely
 * to be dropped and the thing least likely to announce itself, so it goes on
 * top, carrying the last state its owner recorded.
 *
 * Silent when there is neither, so the hook stays quiet on an idle machine.
 */
export function renderInboxBrief(
  items: readonly InboxItem[],
  resume: readonly ResumePoint[] = [],
): void {
  if (items.length === 0 && resume.length === 0) return;

  if (resume.length > 0) {
    out(`komnet: ${String(resume.length)} task(s) in flight — yours, already started`);
    for (const point of resume) {
      out(`  [${point.room}] ${point.title}  (${point.taskId}, ${ago(point.updatedAt)})`);
      if (point.last !== undefined) {
        out(`    last ${point.last.action}: ${firstLine(point.last.body, 160)}`);
      }
    }
    out(
      `Continue this before starting anything new; 'komnet task show <room> <id>' has the full thread.`,
    );
  }

  if (items.length === 0) return;
  if (resume.length > 0) out();
  out(`komnet: ${String(items.length)} pending message(s)`);
  for (const item of items) {
    out(`  [${item.room}] ${item.from} (${item.needs}): ${firstLine(item.body, 100)}`);
  }
  out(`Run 'komnet inbox --drain --json' to process them.`);
}

export function renderMessages(messages: readonly Message[]): void {
  if (messages.length === 0) {
    out(dim("no messages"));
    return;
  }
  for (const m of messages) {
    const h = m.header;
    const marks = [h.kind, h.needs === "none" ? null : needsBadge(h.needs)]
      .filter(Boolean)
      .join(" ");
    const reply = h.inReplyTo === undefined ? "" : dim(` ↳ ${h.inReplyTo.slice(-8)}`);
    out(`${bold(h.from)} ${dim(ago(h.ts))} ${dim(`· ${marks}`)}${reply}`);
    for (const line of m.body.trimEnd().split("\n")) out(`  ${line}`);
    out(dim(`  ${h.id}`));
    out();
  }
}

function healthBadge(health: TaskHealth): string {
  if (health === "stale") return yellow("stale");
  if (health === "blocked") return red("blocked");
  if (health === "stuck") return red("stuck");
  if (health === "done") return dim("done");
  return green("active");
}

/**
 * One task, in full.
 *
 * Prints the bodies rather than summarising them: this exists to be read by an
 * agent that has lost the context of work already in flight, and the evidence
 * of what was tried is the part that cannot be reconstructed.
 */
export function renderTaskDetail(detail: TaskDetail): void {
  const task = detail.task;
  const owner = task.assignee ?? task.target ?? "any agent";
  out(`${bold(task.title)}`);
  // `blocked`/`stuck`/`done` health only repeats the state; staleness is the
  // one signal the state cannot carry, which is why `task list` prefixes it.
  const state = detail.stale ? yellow(`stale/${task.state}`) : cyan(task.state);
  out(
    `${state} · ${owner} · ` + dim(`created by ${task.creator} · updated ${ago(detail.updatedAt)}`),
  );
  out(
    dim(
      `${task.id}  ${detail.stale ? `stale since ${ago(detail.staleAt)}` : `stale after ${detail.staleAt}`}`,
    ),
  );
  out();
  out(bold("definition"));
  for (const line of detail.definition.trimEnd().split("\n")) out(`  ${line}`);
  out();
  out(bold(`history (${String(detail.events.length)} events · ${detail.participants.join(", ")})`));
  for (const event of detail.events) {
    out(
      `  ${cyan(event.action.padEnd(11))} ${bold(event.from.padEnd(18))} ` +
        dim(`${ago(event.ts)} · → ${event.state}`) +
        (event.needs === "human" ? ` ${red("needs:human")}` : ""),
    );
    for (const line of event.body.trimEnd().split("\n")) out(`    ${line}`);
    for (const ref of event.refs) out(dim(`    ref: ${ref}`));
    out(dim(`    ${event.messageId}`));
  }
  if (detail.invalidEvents.length > 0) {
    out();
    out(red(`${String(detail.invalidEvents.length)} rejected event(s)`));
    for (const invalid of detail.invalidEvents) {
      out(dim(`  ${invalid.messageId}  ${invalid.reason}`));
    }
  }
}

/** Cross-room commitments, with work that has stopped moving first. */
export function renderAgenda(agenda: Agenda): void {
  const counts = agenda.counts;
  if (agenda.entries.length === 0) {
    out(dim("nothing on this agent's agenda"));
    return;
  }
  for (const entry of agenda.entries) {
    const task = entry.status.task;
    // The work in hand is marked, not just sorted first: an agent scanning this
    // list should be able to see which line it is already standing on.
    const mark = entry.needsAttention ? yellow("!") : entry.inFlight ? green("▸") : " ";
    out(
      `${mark} ${dim(entry.relation.padEnd(9))} ${healthBadge(entry.status.health).padEnd(16)} ` +
        `${cyan(`#${entry.room}`.padEnd(16))} ${task.title}`,
    );
    out(dim(`    ${task.id}  ${ago(entry.status.updatedAt)}`));
  }
  out();
  out(
    (counts.inFlight === 0 ? "" : `${green(`${String(counts.inFlight)} in flight`)} · `) +
      `${String(counts.assigned)} assigned · ${String(counts.offered)} offered · ` +
      `${String(counts.created)} created · ${String(counts.unclaimed)} unclaimed` +
      (counts.needsAttention === 0
        ? ""
        : ` · ${yellow(`${String(counts.needsAttention)} need attention`)}`),
  );
}

export function messageToJson(m: Message): Record<string, unknown> {
  const h = m.header;
  return {
    id: h.id,
    room: h.room,
    from: h.from,
    authorKind: h.authorKind,
    ts: h.ts,
    kind: h.kind,
    needs: h.needs,
    thread: h.thread,
    inReplyTo: h.inReplyTo ?? null,
    mentions: h.mentions,
    priority: h.priority,
    tags: h.tags,
    refs: h.refs,
    review: h.review ?? null,
    task: h.task ?? null,
    body: m.body,
  };
}
