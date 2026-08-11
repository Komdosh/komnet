import { randomFillSync } from "node:crypto";

/**
 * ULID — 26 chars, Crockford base32: 48-bit big-endian timestamp then 80 bits of
 * randomness.
 *
 * Chosen over UUIDv4 because komnet sorts messages by identifier constantly:
 * a lexicographic sort of ULIDs is a chronological sort, so a directory listing
 * is already in conversation order and needs no index to read. Chosen over a
 * bare timestamp because two agents WILL write in the same millisecond and the
 * random tail keeps their filenames distinct without coordination.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: no I, L, O, U
const TIME_LEN = 10;
const RANDOM_LEN = 16;
export const ULID_LENGTH = TIME_LEN + RANDOM_LEN;

/** Largest timestamp representable in 48 bits: 10889-08-02T05:31:50.655Z. */
export const MAX_ULID_TIME = 281_474_976_710_655;

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// Monotonic state: two ULIDs minted in the same millisecond by this process must
// still sort in mint order, otherwise a burst of replies can land out of order.
let lastTime = -1;
const lastRandom = new Uint8Array(RANDOM_LEN);

function encodeTime(time: number): string {
  let remaining = time;
  const out: string[] = Array.from({ length: TIME_LEN }, () => "");
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = remaining % 32;
    out[i] = ALPHABET[mod] as string;
    remaining = (remaining - mod) / 32;
  }
  return out.join("");
}

/**
 * Fill with fresh randomness. Each byte is masked to 5 bits; 256 is a multiple
 * of 32, so the low bits of a uniform byte are themselves uniform — no modulo
 * bias.
 */
function freshRandom(): void {
  randomFillSync(lastRandom);
  for (let i = 0; i < RANDOM_LEN; i++) {
    lastRandom[i] = (lastRandom[i] as number) & 31;
  }
}

/** Increment the random tail as a base-32 big integer, for same-millisecond mints. */
function incrementRandom(): void {
  for (let i = RANDOM_LEN - 1; i >= 0; i--) {
    const next = (lastRandom[i] as number) + 1;
    if (next < 32) {
      lastRandom[i] = next;
      return;
    }
    lastRandom[i] = 0;
  }
  // Overflowed all 80 bits inside one millisecond. Not reachable in practice —
  // it needs 2^80 mints in under a millisecond — but wrapping silently would
  // break the sort order this type exists to guarantee.
  throw new Error("ulid: random component overflowed within a single millisecond");
}

/**
 * Mint a ULID. Strictly increasing for this process even when the clock stalls
 * or steps backwards; across processes, ordering falls back to the timestamp.
 */
export function ulid(now: number = Date.now()): string {
  const time = Math.floor(now);
  if (!Number.isFinite(time) || time < 0 || time > MAX_ULID_TIME) {
    throw new RangeError(`ulid: timestamp ${String(now)} out of range`);
  }

  if (time > lastTime) {
    lastTime = time;
    freshRandom();
  } else {
    // Clock stalled or went backwards (NTP step, VM resume). Keep the previous
    // timestamp and bump the tail so ordering never regresses.
    incrementRandom();
  }

  let tail = "";
  for (let i = 0; i < RANDOM_LEN; i++) {
    tail += ALPHABET[lastRandom[i] as number];
  }
  return encodeTime(lastTime) + tail;
}

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

/** Extract the mint time. Throws on a malformed identifier. */
export function ulidTime(value: string): number {
  if (!isUlid(value)) {
    throw new TypeError(`not a ULID: ${JSON.stringify(value)}`);
  }
  let time = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    time = time * 32 + ALPHABET.indexOf(value[i] as string);
  }
  return time;
}

/** Chronological comparator. Plain string comparison — the encoding does the work. */
export function compareUlid(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
