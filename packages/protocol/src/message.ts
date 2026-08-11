import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { MalformedMessageError, UnsupportedVersionError } from "./errors.ts";
import { isUlid } from "./ids.ts";
import { isAgentId, isRoomId } from "./identifiers.ts";
import { PROTOCOL_VERSION, isSupportedVersion } from "./version.ts";

/*
 * Note on `as const` objects instead of `enum`: Node's type stripping requires
 * erasable syntax only, so `enum` is unavailable by construction. See
 * docs/adr/0010-typescript-node-stack.md.
 */

export const MESSAGE_KINDS = [
  "msg",
  "question",
  "answer",
  "decision",
  "status",
  "artifact",
  "system",
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const NEEDS_VALUES = ["none", "agent", "human"] as const;
export type Needs = (typeof NEEDS_VALUES)[number];

export const PRIORITIES = ["low", "normal", "high", "blocking"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const AUTHOR_KINDS = ["agent", "human"] as const;
export type AuthorKind = (typeof AUTHOR_KINDS)[number];

/** Routing token meaning "everyone subscribed to this room". */
export const MENTION_ROOM = "@room";

export interface MessageHeader {
  v: number;
  id: string;
  room: string;
  from: string;
  authorKind: AuthorKind;
  /** RFC 3339, UTC, millisecond precision. */
  ts: string;
  kind: MessageKind;
  /** Thread root id. Equals `id` on a root message. */
  thread: string;
  needs: Needs;
  inReplyTo?: string;
  mentions: string[];
  priority: Priority;
  tags: string[];
  refs: string[];
  /** Transport commit the author had observed when writing. */
  seen?: string;
  sig?: string;
  unsafeReason?: string;
  /**
   * Header fields this build does not recognise, preserved verbatim.
   *
   * Required by ADR 0007: sealing rewrites messages, so without preservation an
   * older node performing a seal would silently strip fields written by a newer
   * one — data loss triggered by routine background maintenance.
   */
  extra: Record<string, unknown>;
}

export interface Message {
  header: MessageHeader;
  body: string;
}

/** Wire (snake_case) ↔ model (camelCase). Fields not listed share a name. */
const WIRE_TO_MODEL = {
  author_kind: "authorKind",
  in_reply_to: "inReplyTo",
  unsafe_reason: "unsafeReason",
} as const;

const MODEL_TO_WIRE: Record<string, string> = Object.fromEntries(
  Object.entries(WIRE_TO_MODEL).map(([wire, model]) => [model, wire]),
);

/** Emission order. Fixed so that re-serialising a message produces no spurious diff. */
const WIRE_ORDER = [
  "v",
  "id",
  "room",
  "from",
  "author_kind",
  "ts",
  "kind",
  "thread",
  "in_reply_to",
  "needs",
  "mentions",
  "priority",
  "tags",
  "refs",
  "seen",
  "unsafe_reason",
  "sig",
] as const;

const KNOWN_WIRE_KEYS = new Set<string>(WIRE_ORDER);

const DELIMITER = "---";

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function requireString(
  raw: Record<string, unknown>,
  key: string,
  source: string | undefined,
): string {
  const value = raw[key];
  if (!isNonEmptyString(value)) {
    throw new MalformedMessageError(`header field ${key} must be a non-empty string`, source);
  }
  return value;
}

function requireEnum<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  source: string | undefined,
): T {
  const value = raw[key];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new MalformedMessageError(
      `header field ${key} must be one of: ${allowed.join(", ")}`,
      source,
    );
  }
  return value as T;
}

function optionalStringArray(
  raw: Record<string, unknown>,
  key: string,
  source: string | undefined,
): string[] {
  const value = raw[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new MalformedMessageError(`header field ${key} must be an array of strings`, source);
  }
  return value as string[];
}

/**
 * Split a raw file into its frontmatter and body.
 *
 * CRLF is normalised on read: the spec mandates LF, but a Windows editor
 * touching a message should degrade to a formatting nit rather than an
 * unparseable file.
 */
export function splitFrontmatter(
  raw: string,
  source?: string,
): { frontmatter: string; body: string } {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith(`${DELIMITER}\n`)) {
    throw new MalformedMessageError("file must begin with a '---' frontmatter delimiter", source);
  }
  const end = text.indexOf(`\n${DELIMITER}\n`, DELIMITER.length);
  if (end === -1) {
    throw new MalformedMessageError("unterminated frontmatter: no closing '---'", source);
  }
  return {
    frontmatter: text.slice(DELIMITER.length + 1, end + 1),
    body: text.slice(end + `\n${DELIMITER}\n`.length),
  };
}

export function parseMessage(raw: string, source?: string): Message {
  const { frontmatter, body } = splitFrontmatter(raw, source);

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatter);
  } catch (cause) {
    throw new MalformedMessageError("frontmatter is not valid YAML", source, { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MalformedMessageError("frontmatter must be a YAML mapping", source);
  }
  const rawHeader = parsed as Record<string, unknown>;

  const v = rawHeader["v"];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new MalformedMessageError("header field v must be an integer", source);
  }
  // Surfaced, never silently dropped — quietly discarding a newer peer's traffic
  // is how a network splits in half without anyone noticing (ADR 0007).
  if (!isSupportedVersion(v)) throw new UnsupportedVersionError(v);

  const id = requireString(rawHeader, "id", source);
  if (!isUlid(id)) {
    throw new MalformedMessageError(`header field id is not a ULID: ${id}`, source);
  }
  const room = requireString(rawHeader, "room", source);
  if (!isRoomId(room)) {
    throw new MalformedMessageError(`header field room is not a valid room id: ${room}`, source);
  }
  const from = requireString(rawHeader, "from", source);
  if (!isAgentId(from)) {
    throw new MalformedMessageError(`header field from is not a valid agent id: ${from}`, source);
  }
  const thread = requireString(rawHeader, "thread", source);
  if (!isUlid(thread)) {
    throw new MalformedMessageError(`header field thread is not a ULID: ${thread}`, source);
  }

  const ts = requireString(rawHeader, "ts", source);
  if (Number.isNaN(Date.parse(ts))) {
    throw new MalformedMessageError(`header field ts is not a valid timestamp: ${ts}`, source);
  }

  const inReplyTo = rawHeader["in_reply_to"];
  if (inReplyTo !== undefined && inReplyTo !== null) {
    if (typeof inReplyTo !== "string" || !isUlid(inReplyTo)) {
      throw new MalformedMessageError("header field in_reply_to must be a ULID", source);
    }
  }

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawHeader)) {
    if (!KNOWN_WIRE_KEYS.has(key)) extra[key] = value;
  }

  const header: MessageHeader = {
    v,
    id,
    room,
    from,
    authorKind: requireEnum(rawHeader, "author_kind", AUTHOR_KINDS, source),
    ts,
    kind: requireEnum(rawHeader, "kind", MESSAGE_KINDS, source),
    thread,
    needs: requireEnum(rawHeader, "needs", NEEDS_VALUES, source),
    mentions: optionalStringArray(rawHeader, "mentions", source),
    priority:
      rawHeader["priority"] === undefined || rawHeader["priority"] === null
        ? "normal"
        : requireEnum(rawHeader, "priority", PRIORITIES, source),
    tags: optionalStringArray(rawHeader, "tags", source),
    refs: optionalStringArray(rawHeader, "refs", source),
    extra,
  };

  if (typeof inReplyTo === "string") header.inReplyTo = inReplyTo;
  if (isNonEmptyString(rawHeader["seen"])) header.seen = rawHeader["seen"];
  if (isNonEmptyString(rawHeader["sig"])) header.sig = rawHeader["sig"];
  if (isNonEmptyString(rawHeader["unsafe_reason"])) {
    header.unsafeReason = rawHeader["unsafe_reason"];
  }

  return { header, body };
}

/** Model → wire mapping, dropping empty optionals so diffs stay minimal. */
function toWire(header: MessageHeader): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(header)) {
    if (key === "extra") continue;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    wire[MODEL_TO_WIRE[key] ?? key] = value;
  }
  return { ...header.extra, ...wire };
}

function emit(wire: Record<string, unknown>, keyOrder: readonly string[]): string {
  const ordered: Record<string, unknown> = {};
  for (const key of keyOrder) {
    if (key in wire) ordered[key] = wire[key];
  }
  return stringifyYaml(ordered, { lineWidth: 0 });
}

export function serializeMessage(message: Message): string {
  const wire = toWire(message.header);
  // Known fields in declared order, then unknown fields sorted — deterministic
  // output means re-serialising never produces a spurious diff.
  const unknown = Object.keys(wire)
    .filter((k) => !KNOWN_WIRE_KEYS.has(k))
    .sort();
  const yaml = emit(wire, [...WIRE_ORDER, ...unknown]);
  const body = message.body.endsWith("\n") ? message.body : `${message.body}\n`;
  return `${DELIMITER}\n${yaml}${DELIMITER}\n${body}`;
}

/**
 * Canonical bytes for signing (spec §10.1): every header field except `sig`,
 * keys sorted lexicographically — including unknown ones, so a signature stays
 * verifiable across versions — then a newline, then the body verbatim.
 */
export function canonicalForm(message: Message): string {
  const wire = toWire(message.header);
  delete wire["sig"];
  const yaml = emit(wire, Object.keys(wire).sort());
  return `${yaml}\n${message.body}`;
}

/** A thread root is its own thread. */
export function isThreadRoot(header: MessageHeader): boolean {
  return header.thread === header.id;
}

/**
 * Whether this message is routed to `agentId`, given its subscriptions.
 * Messages matching nothing are still recorded — routing and recording are
 * separate concerns (see docs/design/05-delivery-and-humans.md §2).
 */
export function isAddressedTo(
  header: MessageHeader,
  agentId: string,
  subscribedRooms: ReadonlySet<string>,
): boolean {
  if (header.from === agentId) return false;
  if (header.mentions.includes(agentId)) return true;
  return header.mentions.includes(MENTION_ROOM) && subscribedRooms.has(header.room);
}

export interface NewMessageInput {
  id: string;
  room: string;
  from: string;
  authorKind: AuthorKind;
  kind: MessageKind;
  needs: Needs;
  body: string;
  ts?: string;
  thread?: string;
  inReplyTo?: string;
  mentions?: string[];
  priority?: Priority;
  tags?: string[];
  refs?: string[];
  seen?: string;
}

/** Build a well-formed message, defaulting `thread` to a new root. */
export function createMessage(input: NewMessageInput): Message {
  const header: MessageHeader = {
    v: PROTOCOL_VERSION,
    id: input.id,
    room: input.room,
    from: input.from,
    authorKind: input.authorKind,
    ts: input.ts ?? new Date().toISOString(),
    kind: input.kind,
    thread: input.thread ?? input.id,
    needs: input.needs,
    mentions: input.mentions ?? [],
    priority: input.priority ?? "normal",
    tags: input.tags ?? [],
    refs: input.refs ?? [],
    extra: {},
  };
  if (input.inReplyTo !== undefined) header.inReplyTo = input.inReplyTo;
  if (input.seen !== undefined) header.seen = input.seen;
  return { header, body: input.body };
}
