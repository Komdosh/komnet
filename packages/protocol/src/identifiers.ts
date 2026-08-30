import { InvalidIdentifierError } from "./errors.ts";

/**
 * Room and agent identifiers become BOTH filesystem paths AND git ref components
 * (`room/<id>`), so they are constrained to the intersection of what those two
 * accept — lowercase, no dots, no leading/trailing dash.
 *
 * Lowercase is not cosmetic: macOS and Windows checkouts are case-insensitive,
 * so `room/Arch` and `room/arch` would collide on those machines while remaining
 * distinct refs on the server. Forbidding uppercase removes the failure mode.
 */
const ROOM_ID_RULE = "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$";
const ROOM_ID_PATTERN = new RegExp(ROOM_ID_RULE);

/** Agent ids additionally allow `.` and `_`; convention is `<person>-<tool>`. */
const AGENT_ID_RULE = "^[a-z0-9](?:[a-z0-9._-]{0,38}[a-z0-9])?$";
const AGENT_ID_PATTERN = new RegExp(AGENT_ID_RULE);

/**
 * Room names that would produce a confusing or broken ref. `head` and `main`
 * are refused because `room/head` reads as ambiguous in tooling output even
 * though git itself would accept it.
 */
const RESERVED_ROOM_IDS = new Set(["head", "main", "master", "komnet", "refs"]);

export function isRoomId(value: string): boolean {
  return ROOM_ID_PATTERN.test(value) && !RESERVED_ROOM_IDS.has(value);
}

export function isAgentId(value: string): boolean {
  return AGENT_ID_PATTERN.test(value);
}

export function assertRoomId(value: string): string {
  if (!ROOM_ID_PATTERN.test(value)) {
    throw new InvalidIdentifierError("room id", value, ROOM_ID_RULE);
  }
  if (RESERVED_ROOM_IDS.has(value)) {
    throw new InvalidIdentifierError(
      "room id",
      value,
      `a name other than: ${[...RESERVED_ROOM_IDS].join(", ")}`,
    );
  }
  return value;
}

export function assertAgentId(value: string): string {
  if (!AGENT_ID_PATTERN.test(value)) {
    throw new InvalidIdentifierError("agent id", value, AGENT_ID_RULE);
  }
  return value;
}

/**
 * Best-effort coercion of free text into a legal id, for `komnet room create
 * "API Design"`. Returns null when nothing usable survives, rather than
 * inventing a name the caller did not intend.
 */
export function slugify(input: string, maxLength = 63): string | null {
  const slug = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : null;
}

/**
 * Machine ids share the agent grammar, because they are addressed the same way
 * and end up in the same places — a mention token, a task target, a filename in
 * an error message. One rule is one thing to get wrong.
 */
const MACHINE_ID_RULE = AGENT_ID_RULE;
const MACHINE_ID_PATTERN = new RegExp(MACHINE_ID_RULE);

/**
 * Prefix that turns a machine id into a routing token.
 *
 * A mention list holds agent ids, so a machine has to be distinguishable from
 * an agent that happens to be named after a laptop. The prefix does that in the
 * one place it matters and stays readable in a header a person is reading:
 * `mentions: [machine:komdosh-mbp]`.
 *
 * `:` is already legal in `mentions` (nothing validates the array) and illegal
 * in an agent id, so no existing token can collide with one of these, and a
 * build that predates machine addressing simply fails to match it rather than
 * mis-delivering.
 */
export const MENTION_MACHINE_PREFIX = "machine:";

export function isMachineId(value: string): boolean {
  return MACHINE_ID_PATTERN.test(value);
}

export function assertMachineId(value: string): string {
  if (!MACHINE_ID_PATTERN.test(value)) {
    throw new InvalidIdentifierError("machine id", value, MACHINE_ID_RULE);
  }
  return value;
}

/** `komdosh-mbp` → `machine:komdosh-mbp`. */
export function machineMention(machineId: string): string {
  return `${MENTION_MACHINE_PREFIX}${assertMachineId(machineId)}`;
}

/** Whether a mention token or task target addresses a machine rather than an agent. */
export function isMachineToken(value: string): boolean {
  return machineFromToken(value) !== null;
}

/**
 * `machine:komdosh-mbp` → `komdosh-mbp`, or null for anything else.
 *
 * Never throws: this runs over mention arrays written on other machines, and a
 * malformed token there is data to ignore, not an error to propagate.
 */
export function machineFromToken(value: string): string | null {
  if (!value.startsWith(MENTION_MACHINE_PREFIX)) return null;
  const id = value.slice(MENTION_MACHINE_PREFIX.length);
  return isMachineId(id) ? id : null;
}

/**
 * The room a machine's own agents share.
 *
 * Derived rather than configured so every agent on the box computes the same
 * name without coordinating. Room ids forbid `.` and `_`, which machine ids
 * allow, so the id is slugified — and prefixed when the slug would be a
 * reserved room name, which is the only case where an honest derivation would
 * otherwise fail.
 */
export function machineRoomId(machineId: string): string {
  const slug = slugify(assertMachineId(machineId));
  if (slug === null) return "machine";
  return isRoomId(slug) ? slug : `machine-${slug}`.slice(0, 63).replace(/-+$/g, "");
}
