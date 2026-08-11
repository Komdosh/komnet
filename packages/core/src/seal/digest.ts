import type { Message } from "@komnet/protocol";

export interface DigestInput {
  roomId: string;
  period: string;
  messages: readonly Message[];
  /** `git log` range that still holds the raw messages after pruning. */
  gitRange: string;
  decisions: readonly { seq: number; title: string; path: string }[];
}

/**
 * Render the structural section of a digest.
 *
 * Deterministic and model-free on purpose: sealing must never block on a live
 * agent being available (ADR 0006). A prose narrative is better, so a seal also
 * posts a `needs: agent` request for one — but if nobody ever drains it, this
 * still stands on its own. Compaction quality degrades; it does not fail.
 */
export function renderDigest(input: DigestInput): string {
  const { roomId, period, messages, gitRange, decisions } = input;

  const byAuthor = new Map<string, number>();
  const byTag = new Map<string, number>();
  for (const m of messages) {
    byAuthor.set(m.header.from, (byAuthor.get(m.header.from) ?? 0) + 1);
    for (const tag of m.header.tags) byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
  }

  const answered = new Set(
    messages
      .filter((m) => m.header.kind === "answer" && m.header.inReplyTo !== undefined)
      .map((m) => m.header.inReplyTo as string),
  );
  // An unresolved question is the one thing a digest must not lose: pruning the
  // raw messages would otherwise silently drop a decision someone is waiting on.
  const unresolved = messages.filter(
    (m) => m.header.needs !== "none" && !answered.has(m.header.id),
  );

  const threads = new Map<string, Message[]>();
  for (const m of messages) {
    const bucket = threads.get(m.header.thread);
    if (bucket === undefined) threads.set(m.header.thread, [m]);
    else bucket.push(m);
  }

  const first = messages[0]?.header.ts ?? "";
  const last = messages[messages.length - 1]?.header.ts ?? "";

  const lines: string[] = [
    `# ${roomId} — ${period}`,
    "",
    `Sealed ${String(messages.length)} message(s)` +
      (first === "" ? "" : ` from ${first.slice(0, 10)} to ${last.slice(0, 10)}`) +
      ".",
    "",
    "## Participants",
    "",
  ];

  for (const [author, count] of [...byAuthor].sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${author} — ${String(count)}`);
  }

  lines.push("", "## Decisions", "");
  if (decisions.length === 0) lines.push("_None recorded in this period._");
  else
    for (const d of decisions)
      lines.push(`- [${d.title}](../${d.path.split("/").slice(-2).join("/")})`);

  lines.push("", "## Unresolved questions", "");
  if (unresolved.length === 0) {
    lines.push("_None — everything that needed an answer got one._");
  } else {
    lines.push("Carried forward; these were still open when the period was sealed.", "");
    for (const m of unresolved) {
      lines.push(
        `- **${m.header.needs === "human" ? "needs a human" : "needs an agent"}** · ${m.header.from} · \`${m.header.id}\``,
      );
      lines.push(`  > ${firstLine(m)}`);
    }
  }

  lines.push("", "## Threads", "");
  for (const [root, group] of threads) {
    const opener = group[0] as Message;
    lines.push(
      `- \`${root.slice(-8)}\` (${String(group.length)}) ${opener.header.from}: ${firstLine(opener)}`,
    );
  }

  if (byTag.size > 0) {
    lines.push("", "## Tags", "");
    lines.push(
      [...byTag]
        .sort((a, b) => b[1] - a[1])
        .map(([tag, count]) => `\`${tag}\` ${String(count)}`)
        .join(" · "),
    );
  }

  lines.push(
    "",
    "## Raw history",
    "",
    "The messages summarised here were removed from the working tree but remain in git",
    "history in full. To read them:",
    "",
    "```console",
    `git log ${gitRange} --diff-filter=A --name-only -- rooms/${roomId}/msg/`,
    "```",
    "",
    `Or: \`komnet history ${roomId} --since <date>\``,
    "",
  );

  return lines.join("\n");
}

function firstLine(message: Message): string {
  const line = message.body.trim().split("\n")[0] ?? "";
  return line.length > 110 ? `${line.slice(0, 109)}…` : line;
}

/** `rooms/<id>/decisions/<NNNN>-<slug>.md` body for a promoted decision. */
export function renderDecision(input: {
  seq: number;
  title: string;
  decidedBy: string;
  decidedAt: string;
  sourceMessage: string;
  body: string;
}): string {
  return [
    "---",
    "v: 1",
    `seq: ${String(input.seq)}`,
    `title: ${JSON.stringify(input.title)}`,
    `decided_by: ${input.decidedBy}`,
    `decided_at: ${input.decidedAt}`,
    `source_message: ${input.sourceMessage}`,
    "supersedes: null",
    "---",
    "",
    input.body.trim(),
    "",
  ].join("\n");
}
