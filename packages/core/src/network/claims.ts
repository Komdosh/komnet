/**
 * Advisory resource leases, as the network performs them.
 *
 * The reduction lives in `../room/claims.ts` and is pure; this is the half that
 * has to touch the transport — look before writing, write, then look again.
 */

import { createClaim, isResourceName, ulid, type Message } from "@komnet/protocol";

import { currentHolder, reduceClaims, type ClaimStatus } from "../room/claims.ts";
import type { SendInput } from "../network.ts";

/**
 * What claiming needs from the network, and nothing more.
 *
 * Spelled out rather than taking `Network` whole: this is the list a reader has
 * to hold in their head to follow the code below, and keeping it explicit means
 * a new dependency has to be added on purpose instead of appearing through
 * `this`.
 */
export interface ClaimsContext {
  readonly agentId: string;
  assertSubscribed(roomId: string, verb: string): void;
  sync(): Promise<unknown>;
  send(roomId: string, input: SendInput): Promise<Message>;
  read(roomId: string): Promise<Message[]>;
}

/**
 * Current holder of every claimed resource in a room, expiry included.
 *
 * Syncs first, unlike every other read. The others tolerate a stale cache and
 * now say so; a lock cannot, because the dangerous direction is reporting a
 * resource FREE while a peer holds it — which is exactly how two agents end up
 * running the same build. Correctness is worth the round trip here.
 */
export async function listClaims(
  ctx: ClaimsContext,
  roomId: string,
  options: { sync?: boolean } = {},
): Promise<ClaimStatus[]> {
  ctx.assertSubscribed(roomId, "list claims in");
  if (options.sync !== false) await ctx.sync().catch(() => undefined);
  return reduceClaims(await ctx.read(roomId));
}

export async function claimResource(
  ctx: ClaimsContext,
  roomId: string,
  resource: string,
  options: { ttlSeconds?: number; note?: string } = {},
): Promise<{ granted: boolean; status: ClaimStatus | null }> {
  ctx.assertSubscribed(roomId, "claim a resource in");
  if (!isResourceName(resource)) {
    throw new TypeError(
      `not a usable resource name: ${JSON.stringify(resource)} — use [a-z0-9._:/-], e.g. core/social/graph`,
    );
  }

  // Look before leaping: if someone already holds it, do not write at all.
  await ctx.sync().catch(() => undefined);
  const before = currentHolder(await listClaims(ctx, roomId, { sync: false }), resource);
  if (before !== null && before.holder !== ctx.agentId) {
    return { granted: false, status: before };
  }

  const claim = createClaim({
    id: ulid(),
    resource,
    holder: ctx.agentId,
    ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
  });
  await ctx.send(roomId, {
    body: options.note ?? `holding ${resource}`,
    kind: "status",
    needs: "none",
    tags: ["claim", `claim:${resource}`],
    claim,
  });

  // Re-read AFTER writing: a peer may have claimed in the same window.
  await ctx.sync().catch(() => undefined);
  const after = currentHolder(await listClaims(ctx, roomId, { sync: false }), resource);
  return { granted: after !== null && after.holder === ctx.agentId, status: after };
}

/** Release a resource this agent holds. Releasing something you do not hold is a no-op. */
export async function releaseResource(
  ctx: ClaimsContext,
  roomId: string,
  resource: string,
  note?: string,
): Promise<boolean> {
  ctx.assertSubscribed(roomId, "release a resource in");
  const held = currentHolder(await listClaims(ctx, roomId, { sync: false }), resource);
  if (held === null || held.holder !== ctx.agentId) return false;

  await ctx.send(roomId, {
    body: note ?? `released ${resource}`,
    kind: "status",
    needs: "none",
    tags: ["claim", `claim:${resource}`],
    // A release carries the default TTL because the field is required on the
    // wire; the reducer ignores it for `released` events.
    claim: createClaim({
      id: ulid(),
      resource,
      holder: ctx.agentId,
      action: "released",
    }),
  });
  return true;
}
