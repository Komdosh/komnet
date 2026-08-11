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
