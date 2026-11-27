import { assertAgentId, assertRoomId, isUlid } from "@komnet/protocol";

/** One agent's published inbox views in a room. */
export interface ReadReceipt {
  v: number;
  agent: string;
  room: string;
  /** Room-level progress carried by both current and legacy receipts. */
  readThrough: string | null;
  /** Exact message IDs returned by inbox views. Absent on legacy receipts. */
  readIds?: string[];
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
      read_ids: receipt.readIds,
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
  const readIds = record["read_ids"];
  return {
    v: Number(record["v"] ?? 1),
    agent,
    room,
    readThrough: typeof readThrough === "string" && isUlid(readThrough) ? readThrough : null,
    ...(Array.isArray(readIds)
      ? { readIds: readIds.filter((id): id is string => typeof id === "string" && isUlid(id)) }
      : {}),
    count: Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0,
    updatedAt: String(record["updated_at"] ?? new Date(0).toISOString()),
  };
}
