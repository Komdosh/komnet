import { MalformedMessageError } from "./errors.ts";
import { isUlid } from "./ids.ts";
import { isAgentId } from "./identifiers.ts";

/**
 * An advisory lease on a shared resource.
 *
 * Two agents on one machine starved each other's Gradle builds, so they invented
 * a lock out of chat messages — "BUILD-START core/social/graph", then
 * "BUILD-DONE, token released". That convention was load-bearing and enforced by
 * nothing: a missed message meant two concurrent builds, and nothing expired if
 * the holder crashed.
 *
 * This is the same idea with the guessing removed. Claims are append-only events
 * like every other komnet fact, reduced deterministically, and every hold
 * carries a TTL so a dead holder frees the resource on its own.
 *
 * **Advisory, not a mutex.** The transport is git: two agents can both believe
 * they hold a resource until their next sync. `Network.claimResource` closes
 * that window by re-reading after it writes and reporting who actually won —
 * but nothing can make this a kernel lock, and a caller that skips the check
 * gets exactly the convention it replaced.
 */

export const CLAIM_ACTIONS = ["held", "released"] as const;
export type ClaimAction = (typeof CLAIM_ACTIONS)[number];

export const DEFAULT_CLAIM_TTL_SECONDS = 15 * 60;
const MIN_CLAIM_TTL_SECONDS = 30;
const MAX_CLAIM_TTL_SECONDS = 24 * 60 * 60;
const MAX_RESOURCE_LENGTH = 120;

export interface Claim {
  id: string;
  resource: string;
  action: ClaimAction;
  holder: string;
  /** How long this hold is good for, from the event's timestamp. */
  ttlSeconds: number;
}

export const CLAIM_WIRE_KEYS = [
  "claim_id",
  "claim_resource",
  "claim_action",
  "claim_holder",
  "claim_ttl_seconds",
] as const;

/**
 * A resource name any two agents would spell the same way.
 *
 * Deliberately narrow: a lock nobody can typo is worth more than one that
 * accepts anything. Paths and build targets fit — `core/social/graph`,
 * `gradle:assemble`.
 */
export function isResourceName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_RESOURCE_LENGTH &&
    /^[a-z0-9][a-z0-9._:/-]*$/i.test(value) &&
    !value.includes("..")
  );
}

export function isClaimAction(value: unknown): value is ClaimAction {
  return typeof value === "string" && (CLAIM_ACTIONS as readonly string[]).includes(value);
}

export function createClaim(input: {
  id: string;
  resource: string;
  holder: string;
  action?: ClaimAction;
  ttlSeconds?: number;
}): Claim {
  return parseClaim({
    claim_id: input.id,
    claim_resource: input.resource,
    claim_action: input.action ?? "held",
    claim_holder: input.holder,
    claim_ttl_seconds: input.ttlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS,
  }) as Claim;
}

export function parseClaim(raw: Record<string, unknown>, source?: string): Claim | undefined {
  const present = CLAIM_WIRE_KEYS.filter((key) => raw[key] !== undefined && raw[key] !== null);
  if (present.length === 0) return undefined;

  const id = raw["claim_id"];
  if (typeof id !== "string" || !isUlid(id)) {
    throw new MalformedMessageError("header field claim_id must be a ULID", source);
  }
  const resource = raw["claim_resource"];
  if (!isResourceName(resource)) {
    throw new MalformedMessageError(
      `header field claim_resource must be a short name of [a-z0-9._:/-], got ${JSON.stringify(resource)}`,
      source,
    );
  }
  const action = raw["claim_action"];
  if (!isClaimAction(action)) {
    throw new MalformedMessageError(
      `header field claim_action must be one of: ${CLAIM_ACTIONS.join(", ")}`,
      source,
    );
  }
  const holder = raw["claim_holder"];
  if (typeof holder !== "string" || !isAgentId(holder)) {
    throw new MalformedMessageError("header field claim_holder must be a valid agent id", source);
  }
  const ttlSeconds = raw["claim_ttl_seconds"];
  if (
    typeof ttlSeconds !== "number" ||
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < MIN_CLAIM_TTL_SECONDS ||
    ttlSeconds > MAX_CLAIM_TTL_SECONDS
  ) {
    throw new MalformedMessageError(
      `header field claim_ttl_seconds must be an integer from ${String(MIN_CLAIM_TTL_SECONDS)} to ${String(MAX_CLAIM_TTL_SECONDS)}`,
      source,
    );
  }

  return { id, resource, action, holder, ttlSeconds };
}

export function claimToWire(claim: Claim): Record<string, unknown> {
  return {
    claim_id: claim.id,
    claim_resource: claim.resource,
    claim_action: claim.action,
    claim_holder: claim.holder,
    claim_ttl_seconds: claim.ttlSeconds,
  };
}
