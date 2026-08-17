/**
 * What this machine has committed but not yet pushed.
 *
 * Derived from git rather than a queue file: a committed message is already
 * durable, so git IS the outbox and cannot drift out of sync with itself.
 *
 * Notably this context calls nothing back into the network — it is git, the
 * layout and the state database, which is why it extracts cleanly.
 */

import { MAIN_REF, roomRef } from "@komnet/protocol";

import { exists } from "../fs.ts";
import type { Layout } from "../layout.ts";
import type { OutboxEntry } from "../network.ts";
import type { Repo } from "../git/repo.ts";
import type { StateDb } from "../state.ts";

const REMOTE = "origin";

/** What the outbox needs from the network, and nothing more. */
export interface OutboxContext {
  readonly networkId: string;
  readonly layout: Layout;
  readonly repo: Repo;
  readonly state: StateDb;
  /** Read live: a long-lived process picks up joins and leaves. */
  readonly subscriptions: readonly string[];
  readonly remote: string;
  readonly recordWorktree: string;
}

/** Rooms holding local commits the remote has not seen. */
export async function outbox(ctx: OutboxContext): Promise<OutboxEntry[]> {
  const pending: OutboxEntry[] = [];
  const meta = (key: string): string | null => {
    const value = ctx.state.getMeta(key);
    return value === null || value === "" ? null : value;
  };
  for (const roomId of ctx.subscriptions) {
    const worktree = ctx.layout.roomWorktree(ctx.networkId, roomId);
    if (!(await exists(worktree))) continue;
    const ahead = await ctx.repo.aheadCount(worktree, `refs/remotes/${REMOTE}/${roomRef(roomId)}`);
    if (ahead > 0) {
      pending.push({
        roomId,
        ahead,
        since: meta(`queuedSince:${roomId}`),
        // Why it is still here, in the terms the user's own git printed —
        // without the flag soup komnet passed to get there.
        reason: meta(`queuedReason:${roomId}`),
      });
    }
  }
  return pending;
}

/**
 * Push anything queued while offline. Ordering is preserved automatically —
 * they are consecutive commits on the room branch.
 */
export async function drainOutbox(
  ctx: OutboxContext,
): Promise<{ roomId: string; pushed: number }[]> {
  const drained: { roomId: string; pushed: number }[] = [];
  for (const { roomId, ahead } of await outbox(ctx)) {
    const worktree = ctx.layout.roomWorktree(ctx.networkId, roomId);
    try {
      await ctx.repo.pushWithRetry(worktree, roomRef(roomId), { remote: REMOTE });
      // Refresh the remote-tracking ref. `ahead` is measured against it, and an
      // explicit `push <branch>:<branch>` does not reliably move it — so
      // without this the same commits look queued forever and get re-pushed on
      // every sync.
      await ctx.repo
        .fetch(ctx.remote, [
          `+refs/heads/${roomRef(roomId)}:refs/remotes/${REMOTE}/${roomRef(roomId)}`,
        ])
        .catch(() => undefined);
      ctx.state.setMeta(`queuedSince:${roomId}`, "");
      drained.push({ roomId, pushed: ahead });
    } catch {
      // Still unreachable. Leave it queued; the next sync tries again.
    }
  }
  return drained;
}

/**
 * Agent-card, profile, and room-policy commits can also be left local by an
 * outage or a contended `main` push. Keep that record branch convergent just
 * like room outboxes, without pretending an advisory presence write is a
 * message.
 */
export async function drainRecordOutbox(ctx: OutboxContext): Promise<void> {
  const trackedMain = `refs/remotes/${REMOTE}/${MAIN_REF}`;
  const ahead = await ctx.repo.aheadCount(ctx.recordWorktree, trackedMain);
  if (ahead === 0) return;
  try {
    await ctx.repo.pushWithRetry(ctx.recordWorktree, MAIN_REF, {
      remote: REMOTE,
      maxAttempts: 3,
      backoffBaseMs: 100,
      backoffCapMs: 1_000,
    });
    await ctx.repo.fetch(ctx.remote, [`+refs/heads/${MAIN_REF}:${trackedMain}`]);
  } catch {
    // Still unreachable or contended. The commits remain durable and the next
    // adaptive sync retries; room delivery can continue independently.
  }
}
