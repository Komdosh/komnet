import { assertAgentId, assertRoomId, isUlid } from "@komnet/protocol";

/**
 * What one agent has read of one room.
 *
 * The question this answers is the one an agent could not previously ask at
 * all: *did anyone actually receive that?* Before this, `komnet_send` returned
 * a header field named `seen` — which is the transport commit the AUTHOR had
 * observed when writing, not evidence anybody read anything. The name invites
 * exactly the wrong reading, and there was no real signal to reach for instead.
 *
 * A receipt is one of the agent-owned files it may rewrite (`mayModify`),
 * which is what lets it carry a moving high-water mark
 * without violating append-only.
 */
export interface ReadReceipt {
  v: number;
  agent: string;
  room: string;
  /**
   * The newest message id this agent has processed from its inbox.
   *
   * ULIDs sort chronologically, so a sender compares their own message id
   * against this. The comparison is only meaningful for a message that routing
   * actually delivered to this agent — an unaddressed message never entered
   * their inbox, so a later `readThrough` says nothing about it. `komnet
   * receipts` states that caveat rather than implying universal coverage.
   */
  readThrough: string | null;
  /** How many messages from this room this agent has processed. */
  count: number;
  updatedAt: string;
}

export function serializeReadReceipt(receipt: ReadReceipt): string {
  return `${JSON.stringify(
    {
      v: receipt.v,
      agent: receipt.agent,
      room: receipt.room,
      read_through: receipt.readThrough,
      count: receipt.count,
      updated_at: receipt.updatedAt,
    },
    null,
    2,
  )}\n`;
}

export function parseReadReceipt(raw: string): ReadReceipt {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("read receipt is not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const agent = String(record["agent"] ?? "");
  const room = String(record["room"] ?? "");
  assertAgentId(agent);
  assertRoomId(room);

  const readThrough = record["read_through"];
  const count = Number(record["count"] ?? 0);
  return {
    v: Number(record["v"] ?? 1),
    agent,
    room,
    // A malformed id is dropped rather than trusted: this value is compared
    // against message ids to decide whether something was read.
    readThrough: typeof readThrough === "string" && isUlid(readThrough) ? readThrough : null,
    count: Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0,
    updatedAt: String(record["updated_at"] ?? new Date(0).toISOString()),
  };
}
