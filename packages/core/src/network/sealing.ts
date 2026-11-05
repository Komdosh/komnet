/**
 * Compaction, as the network performs it.
 *
 * The transaction itself is `../seal/sealer.ts`; this decides whether a room is
 * due, holds the lock while it runs, and repairs the local cursor afterwards.
 */

import { roomRef } from "@komnet/protocol";

import { FileLock } from "../lock.ts";
import { conciseFailure } from "../errors.ts";
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
  /** Where the sealer reports what it repaired, resumed or gave up on. */
  log?(line: string): void;
}

/** How long one seal step waits for the network lock behind a sync or a send. */
const STEP_LOCK_TIMEOUT_MS = 10 * 60_000;

/** First automatic retry after a failed seal; doubles per consecutive failure. */
const SEAL_BACKOFF_BASE_MS = 60_000;
/** Ceiling on that wait, so a fixed fault is picked up within the hour. */
const SEAL_BACKOFF_CAP_MS = 60 * 60_000;

function sealer(ctx: SealingContext): Sealer {
  return new Sealer({
    repo: ctx.repo,
    layout: ctx.layout,
    networkId: ctx.networkId,
    agentId: ctx.agentId,
    remote: ctx.remote,
    log: (line) => ctx.log?.(line),
    exclusive: async (step) =>
      await FileLock.withLock(ctx.lockPath, step, { timeoutMs: STEP_LOCK_TIMEOUT_MS }),
  });
}

/** Why the last automatic seal of a room failed, and when it may run again. */
export interface SealFailure {
  roomId: string;
  failures: number;
  since: string;
  retryAt: string;
  reason: string;
}

function meta(ctx: SealingContext, key: string): string | null {
  const value = ctx.state.getMeta(key);
  return value === null || value === "" ? null : value;
}

/** The recorded failure for a room, or null when its last seal succeeded. */
export function sealFailure(ctx: SealingContext, roomId: string): SealFailure | null {
  const failures = Number(meta(ctx, `sealFailures:${roomId}`) ?? 0);
  if (!(failures > 0)) return null;
  return {
    roomId,
    failures,
    since: meta(ctx, `sealFailingSince:${roomId}`) ?? "",
    retryAt: meta(ctx, `sealRetryAt:${roomId}`) ?? "",
    reason: meta(ctx, `sealError:${roomId}`) ?? "",
  };
}

function recordSealFailure(ctx: SealingContext, roomId: string, error: unknown): void {
  const failures = Number(meta(ctx, `sealFailures:${roomId}`) ?? 0) + 1;
  const delay = Math.min(SEAL_BACKOFF_CAP_MS, SEAL_BACKOFF_BASE_MS * 2 ** (failures - 1));
  const now = Date.now();
  ctx.state.setMeta(`sealFailures:${roomId}`, String(failures));
  ctx.state.setMeta(`sealRetryAt:${roomId}`, new Date(now + delay).toISOString());
  ctx.state.setMeta(`sealError:${roomId}`, conciseFailure(error));
  if (meta(ctx, `sealFailingSince:${roomId}`) === null) {
    ctx.state.setMeta(`sealFailingSince:${roomId}`, new Date(now).toISOString());
  }
}

function clearSealFailure(ctx: SealingContext, roomId: string): void {
  for (const key of ["sealFailures", "sealRetryAt", "sealError", "sealFailingSince"]) {
    ctx.state.setMeta(`${key}:${roomId}`, "");
  }
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
  let result: SealResult;
  try {
    // Not under one lock for the whole seal: each step takes it for itself,
    // and fetches run between steps (see `Exclusive`).
    result = await sealer(ctx).seal(roomId, policy);
  } catch (error) {
    try {
      recordSealFailure(ctx, roomId, error);
    } catch {
      // A database closed during shutdown must not replace the real error.
    }
    throw error;
  }
  clearSealFailure(ctx, roomId);
  if (result.sealed > 0) {
    await FileLock.withLock(
      ctx.lockPath,
      async () => {
        // The room worktree just lost files; the local cursor must not claim to
        // have processed a head that no longer exists.
        const head = await ctx.repo.resolveRef(`refs/heads/${roomRef(roomId)}`);
        if (head !== null) ctx.state.setHead(roomId, head);
        ctx.state.setMeta(`lastSealAt:${roomId}`, new Date().toISOString());
      },
      { timeoutMs: STEP_LOCK_TIMEOUT_MS },
    );
  }
  return result;
}

/** Rooms whose live window has outgrown their retention policy. */
export async function roomsNeedingSeal(ctx: SealingContext): Promise<SealDecision[]> {
  const due: SealDecision[] = [];
  for (const roomId of ctx.subscriptions) {
    // A failing seal waits out its backoff — pending transaction or not. It
    // used to bypass the cadence and run again after every sync, forever,
    // holding the network lock across each attempt's fetches.
    const retryAt = meta(ctx, `sealRetryAt:${roomId}`);
    if (retryAt !== null && Date.parse(retryAt) > Date.now()) continue;
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
