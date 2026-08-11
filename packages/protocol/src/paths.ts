import { ULID_LENGTH } from "./ids.ts";
import { assertAgentId, assertRoomId } from "./identifiers.ts";
import type { MessageHeader } from "./message.ts";

/** Number of trailing ULID characters embedded in a message filename. */
export const ULID_TAIL_LENGTH = 10;

export const NET_MANIFEST_PATH = ".komnet/net.yaml";
export const POLICY_PATH = ".komnet/policy.yaml";
export const ALLOWED_SIGNERS_PATH = ".komnet/allowed_signers";

/** The record branch. Room branches are `room/<id>` (see `roomRef`). */
export const MAIN_REF = "main";

/**
 * Git ref carrying a room's live log.
 *
 * Room ids forbid `/`, which matters: git cannot hold both `room/a` and
 * `room/a/b` as refs, so allowing slashes would make some room names silently
 * un-creatable once a sibling existed.
 */
export function roomRef(roomId: string): string {
  return `room/${assertRoomId(roomId)}`;
}

/** Glob for listing every room head in one `ls-remote` (see ADR 0008). */
export const ROOM_REF_GLOB = "refs/heads/room/*";

/** Recover a room id from a ref name, or null if it is not a room ref. */
export function roomIdFromRef(ref: string): string | null {
  const name = ref.replace(/^refs\/heads\//, "");
  if (!name.startsWith("room/")) return null;
  const id = name.slice("room/".length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(id) ? id : null;
}

export function roomDir(roomId: string): string {
  return `rooms/${assertRoomId(roomId)}`;
}

export function roomConfigPath(roomId: string): string {
  return `${roomDir(roomId)}/room.yaml`;
}

export function messageDir(roomId: string, date: Date): string {
  const yyyy = String(date.getUTCFullYear()).padStart(4, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${roomDir(roomId)}/msg/${yyyy}/${mm}/${dd}`;
}

/** `20260811T142233Z` — UTC, whole seconds, matching the `ts` header. */
export function compactTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/**
 * `<YYYYMMDD>T<HHMMSS>Z-<agent-id>-<ulid-tail>.md`
 *
 * Timestamp first so a plain `ls` is in conversation order; agent id so a human
 * scanning a directory sees who; ULID tail so two agents writing in the same
 * second cannot collide. That last part is load-bearing — filename uniqueness is
 * what makes merges conflict-free (ADR 0004).
 */
export function messageFilename(header: MessageHeader): string {
  assertAgentId(header.from);
  const tail = header.id.slice(ULID_LENGTH - ULID_TAIL_LENGTH);
  return `${compactTimestamp(new Date(header.ts))}-${header.from}-${tail}.md`;
}

export function messagePath(header: MessageHeader): string {
  return `${messageDir(header.room, new Date(header.ts))}/${messageFilename(header)}`;
}

export interface ParsedMessagePath {
  room: string;
  year: string;
  month: string;
  day: string;
  timestamp: string;
  agentId: string;
  ulidTail: string;
}

const MESSAGE_PATH_PATTERN =
  /^rooms\/([a-z0-9-]+)\/msg\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{8}T\d{6}Z)-([a-z0-9._-]+)-([0-9A-HJKMNP-TV-Z]{10})\.md$/;

/** Parse a message path, or null if it is not one. Never throws. */
export function parseMessagePath(path: string): ParsedMessagePath | null {
  const m = MESSAGE_PATH_PATTERN.exec(path);
  if (m === null) return null;
  return {
    room: m[1] as string,
    year: m[2] as string,
    month: m[3] as string,
    day: m[4] as string,
    timestamp: m[5] as string,
    agentId: m[6] as string,
    ulidTail: m[7] as string,
  };
}

export function isMessagePath(path: string): boolean {
  return MESSAGE_PATH_PATTERN.test(path);
}

export function digestPath(roomId: string, yearMonth: string, sealId?: string): string {
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
    throw new TypeError(`digest period must be YYYY-MM, got ${JSON.stringify(yearMonth)}`);
  }
  if (sealId !== undefined && !/^[0-9a-f]{16}$/.test(sealId)) {
    throw new TypeError(
      `digest seal id must be 16 lowercase hex characters, got ${JSON.stringify(sealId)}`,
    );
  }
  const suffix = sealId === undefined ? "" : `-${sealId}`;
  return `${roomDir(roomId)}/digest/${yearMonth}${suffix}.md`;
}

export function decisionPath(roomId: string, seq: number, slug: string): string {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new TypeError(`decision sequence must be a positive integer, got ${String(seq)}`);
  }
  return `${roomDir(roomId)}/decisions/${String(seq).padStart(4, "0")}-${slug}.md`;
}

export function receiptPath(roomId: string, agentId: string): string {
  return `${roomDir(roomId)}/receipts/${assertAgentId(agentId)}.json`;
}

export function agentCardPath(agentId: string): string {
  return `agents/${assertAgentId(agentId)}.yaml`;
}

export function sealLockPath(roomId: string): string {
  return `${roomDir(roomId)}/.seal/lock.json`;
}

/** Durable plan used to resume a seal after either branch push is interrupted. */
export function sealTransactionPath(roomId: string): string {
  return `${roomDir(roomId)}/.seal/transaction.json`;
}

/**
 * Whether `agentId` is permitted to modify an existing file at `path`.
 *
 * The append-only invariant in one predicate (ADR 0004): everything else is
 * create-only, and a modification appearing in a fetch is a protocol violation
 * rather than something to merge.
 */
export function mayModify(path: string, agentId: string): boolean {
  return (
    path === agentCardPath(agentId) ||
    /^rooms\/[a-z0-9-]+\/receipts\/(.+)\.json$/.exec(path)?.[1] === agentId
  );
}
