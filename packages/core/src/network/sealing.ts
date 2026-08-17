/**
 * Compaction, as the network performs it.
 *
 * The transaction itself is `../seal/sealer.ts`; this decides whether a room is
 * due, holds the lock while it runs, and repairs the local cursor afterwards.
 */

import { roomRef } from "@komnet/protocol";

import { FileLock } from "../lock.ts";
import {
  DEFAULT_SEAL_POLICY,
  Sealer,
  type SealDecision,
  type SealPolicy,
  type SealResult,
} from "../seal/sealer.ts";
import type { Layout } from "../layout.ts";
import type { Repo } from "../git/repo.ts";
import type { RoomConfig } from "../room/config.ts";
import type { StateDb } from "../state.ts";

/**
 * What sealing needs from the network.
 *
 * Wider than the domains extracted before it, but almost all of it is data the
 * `Sealer` is constructed from. The number worth watching is the behavioural
 * dependency — here exactly one, `readRoomConfig` — because that is what
 * couples a domain to the rest of the object rather than to its own inputs.
 */
export interface SealingContext {
  readonly networkId: string;
  readonly agentId: string;
  readonly remote: string;
  /** Read live: a long-lived process picks up joins and leaves. */
  readonly subscriptions: readonly string[];
  readonly layout: Layout;
  readonly repo: Repo;
  readonly state: StateDb;
  readonly lockPath: string;
  readRoomConfig(roomId: string): Promise<RoomConfig | null>;
}

function sealer(ctx: SealingContext): Sealer {
  return new Sealer({
    repo: ctx.repo,
    layout: ctx.layout,
    networkId: ctx.networkId,
    agentId: ctx.agentId,
    remote: ctx.remote,
  });
}

/** Retention policy for a room, from its config, falling back to the default. */
async function sealPolicy(ctx: SealingContext, roomId: string): Promise<SealPolicy> {
  const room = await ctx.readRoomConfig(roomId);
  if (room === null) return DEFAULT_SEAL_POLICY;
  return {
    ...DEFAULT_SEAL_POLICY,
    windowDays: room.retention.windowDays,
    windowMessages: room.retention.windowMessages,
    minIntervalHours: room.retention.sealMinIntervalHours,
  };
}

/** What sealing this room would do, without touching anything. */
export async function sealDecision(ctx: SealingContext, roomId: string): Promise<SealDecision> {
  return await sealer(ctx).decide(roomId, await sealPolicy(ctx, roomId));
}

/**
 * Compact a room: merge its live branch into `main`, write a digest, promote
 * decisions, then prune the sealed messages out of both trees.
 */
export async function seal(ctx: SealingContext, roomId: string): Promise<SealResult> {
  const policy = await sealPolicy(ctx, roomId);
  return await FileLock.withLock(
    ctx.lockPath,
    async () => {
      const result = await sealer(ctx).seal(roomId, policy);
      if (result.sealed > 0) {
        // The room worktree just lost files; the local cursor must not claim to
        // have processed a head that no longer exists.
        const head = await ctx.repo.resolveRef(`refs/heads/${roomRef(roomId)}`);
        if (head !== null) ctx.state.setHead(roomId, head);
        ctx.state.setMeta(`lastSealAt:${roomId}`, new Date().toISOString());
      }
      return result;
    },
    // Sealing pushes several times; the default lock timeout is too short.
    { timeoutMs: 10 * 60_000 },
  );
}

/** Rooms whose live window has outgrown their retention policy. */
export async function roomsNeedingSeal(ctx: SealingContext): Promise<SealDecision[]> {
  const due: SealDecision[] = [];
  for (const roomId of ctx.subscriptions) {
    const policy = await sealPolicy(ctx, roomId);
    const pending = await sealer(ctx).hasPendingTransaction(roomId);
    const last = ctx.state.getMeta(`lastSealAt:${roomId}`);
    if (
      !pending &&
      last !== null &&
      Date.now() - Date.parse(last) < policy.minIntervalHours * 3_600_000
    ) {
      continue;
    }

    const decision = await sealer(ctx).decide(roomId, policy);
    if (decision.shouldSeal) due.push(decision);
  }
  return due;
}
