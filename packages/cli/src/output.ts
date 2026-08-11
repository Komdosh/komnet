import type { InboxItem } from "@kom-net/core";
import type { Message } from "@kom-net/protocol";

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
    const first = item.body.trim().split("\n")[0] ?? "";
    const preview = first.length > 68 ? `${first.slice(0, 67)}…` : first;
    out(
      `${cyan(item.room.padEnd(16))} ${bold(item.from.padEnd(18))} ${needsBadge(item.needs)}  ${preview}`,
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

/** One-line-per-item form, for injection into an agent session by a hook. */
export function renderInboxBrief(items: readonly InboxItem[]): void {
  if (items.length === 0) return;
  out(`kom-net: ${String(items.length)} pending message(s)`);
  for (const item of items) {
    const first = item.body.trim().split("\n")[0] ?? "";
    out(`  [${item.room}] ${item.from} (${item.needs}): ${first.slice(0, 100)}`);
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
    body: m.body,
  };
}
