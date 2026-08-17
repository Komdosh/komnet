/**
 * Rooms and the subscriptions that follow them.
 *
 * The room-config format is `../room/config.ts`; this is the half that opens a
 * branch, materialises a worktree, and keeps the fetch scope and the published
 * agent card in step with what this agent actually follows.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { MAIN_REF, roomConfigPath, roomRef } from "@komnet/protocol";

import { FileLock } from "../lock.ts";
import { createRoomConfig, parseRoomConfig, serializeRoomConfig } from "../room/config.ts";
import { exists } from "../fs.ts";
import type { Layout } from "../layout.ts";
import type { NetworkConfig } from "../config.ts";
import type { Repo } from "../git/repo.ts";
import type { RoomConfig } from "../room/config.ts";
import type { RoomInfo } from "../network.ts";
import type { StateDb } from "../state.ts";

const REMOTE = "origin";

/** What room management needs from the network. */
export interface RoomsContext {
  readonly networkId: string;
  readonly agentId: string;
  readonly layout: Layout;
  readonly repo: Repo;
  readonly state: StateDb;
  /**
   * The config object itself, not a copy of `subscriptions`.
   *
   * Joining pushes onto that array and leaving REPLACES it, so a snapshot would
   * silently drop the change — this domain owns subscription state rather than
   * reading it.
   */
  readonly config: NetworkConfig;
  readonly recordWorktree: string;
  readonly lockPath: string;
  /** The only call back into the network: announcing what this agent follows. */
  publishAgentCard(): Promise<unknown>;
}

function subscribe(ctx: RoomsContext, roomId: string): void {
  if (!ctx.config.subscriptions.includes(roomId)) ctx.config.subscriptions.push(roomId);
  ctx.config.subscriptions.sort();
}

/**
 * Announce the rooms this agent follows, so peers can predict delivery.
 *
 * Every path that changes `subscriptions` must call this. Creating a room
 * subscribes just as joining one does, and missing it here meant a room's own
 * creator was published as not following it — so peers would be told a message
 * to them could not land, which is worse than publishing nothing.
 *
 * Best effort and outside the repository lock: failing to announce a
 * subscription must not fail the subscription.
 */
async function announceSubscriptions(ctx: RoomsContext): Promise<void> {
  await ctx.publishAgentCard().catch(() => undefined);
}

export async function listRooms(ctx: RoomsContext): Promise<RoomInfo[]> {
  const dir = join(ctx.recordWorktree, "rooms");
  const subscribed = new Set(ctx.config.subscriptions);
  const infos: RoomInfo[] = [];

  if (await exists(dir)) {
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const configPath = join(dir, entry.name, "room.yaml");
      let room: RoomConfig;
      try {
        room = parseRoomConfig(await readFile(configPath, "utf8"));
      } catch {
        continue;
      }
      infos.push({
        id: room.id,
        title: room.title,
        purpose: room.purpose,
        status: room.status,
        subscribed: subscribed.has(room.id),
        materialized: await exists(ctx.layout.roomWorktree(ctx.networkId, room.id)),
        pending: ctx.state.pendingCount(room.id),
      });
    }
  }
  return infos.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Open a room: an orphan branch for its log, plus its config on `main`.
 *
 * `replyBudget` is settable only here, and deliberately: `room.yaml` is a shared
 * file, and `mayModify` lets an agent rewrite only its own card, profile, and
 * receipts — so a room's policy is immutable once opened (ADR 0004). A team that
 * wants agents to talk longer before a thread parks for a person chooses that
 * when opening the room.
 */
export async function createRoom(
  ctx: RoomsContext,
  roomId: string,
  options: { title?: string; purpose?: string; replyBudget?: number } = {},
): Promise<RoomConfig> {
  const room = await FileLock.withLock(ctx.lockPath, async () => {
    const ref = roomRef(roomId);
    const remoteRooms = await ctx.repo.lsRemoteRooms(ctx.config.remote);
    if (remoteRooms.has(roomId)) {
      throw new Error(
        `room ${roomId} already exists — join it instead: komnet room join ${roomId}`,
      );
    }

    const worktree = ctx.layout.roomWorktree(ctx.networkId, roomId);
    await ctx.repo.addOrphanWorktree(worktree, ref);
    await ctx.repo.runner.run(
      ["commit", "--quiet", "--allow-empty", "-m", `komnet: open room ${roomId}`],
      { cwd: worktree },
    );
    await ctx.repo.pushNewBranch(worktree, ref, REMOTE);
    // Establish the remote-tracking ref immediately: the outbox measures against
    // it, and `push --set-upstream` on a fresh orphan does not create it under
    // our scoped refspec.
    await ctx.repo
      .fetch(ctx.config.remote, [`+refs/heads/${ref}:refs/remotes/${REMOTE}/${ref}`])
      .catch(() => undefined);

    const created = createRoomConfig({ ...options, id: roomId, createdBy: ctx.agentId });
    await ctx.repo.commitFile(
      ctx.recordWorktree,
      roomConfigPath(roomId),
      serializeRoomConfig(created),
      `komnet: create room ${roomId}`,
    );
    await ctx.repo.pushWithRetry(ctx.recordWorktree, MAIN_REF, { remote: REMOTE });

    subscribe(ctx, roomId);
    await ctx.repo.setFetchScope(REMOTE, ctx.config.subscriptions);
    return created;
  });
  await announceSubscriptions(ctx);
  return room;
}

export async function joinRoom(ctx: RoomsContext, roomId: string): Promise<void> {
  await FileLock.withLock(ctx.lockPath, async () => {
    subscribe(ctx, roomId);
    await ctx.repo.setFetchScope(REMOTE, ctx.config.subscriptions);
    await ensureRoomWorktree(ctx, roomId);
  });
  // Tell the network, so peers stop mentioning this agent in rooms it cannot
  // hear — and start knowing it can.
  await announceSubscriptions(ctx);
}

export async function leaveRoom(ctx: RoomsContext, roomId: string): Promise<void> {
  await FileLock.withLock(ctx.lockPath, async () => {
    ctx.config.subscriptions = ctx.config.subscriptions.filter((r) => r !== roomId);
    const worktree = ctx.layout.roomWorktree(ctx.networkId, roomId);
    if (await exists(worktree)) await ctx.repo.removeWorktree(worktree, true);
    ctx.state.forgetRoom(roomId);
    await ctx.repo.setFetchScope(REMOTE, ctx.config.subscriptions);
  });
  await announceSubscriptions(ctx);
}

/**
 * Materialise a room's worktree, fetching the branch if this clone has not seen
 * it yet.
 */
export async function ensureRoomWorktree(ctx: RoomsContext, roomId: string): Promise<string> {
  const worktree = ctx.layout.roomWorktree(ctx.networkId, roomId);
  if (await exists(worktree)) return worktree;

  const ref = roomRef(roomId);
  await mkdir(ctx.layout.networkDir(ctx.networkId), { recursive: true });

  if (await ctx.repo.refExists(ref)) {
    await ctx.repo.addWorktree(worktree, ref);
    return worktree;
  }

  await ctx.repo.fetch(ctx.config.remote, [`+refs/heads/${ref}:refs/remotes/${REMOTE}/${ref}`]);
  if (await ctx.repo.refExists(`refs/remotes/${REMOTE}/${ref}`)) {
    await ctx.repo.addWorktree(worktree, ref, { createFrom: `refs/remotes/${REMOTE}/${ref}` });
    return worktree;
  }
  throw new Error(
    `room ${roomId} does not exist on the remote — create it: komnet room create ${roomId}`,
  );
}

export async function readRoomConfig(
  ctx: RoomsContext,
  roomId: string,
): Promise<RoomConfig | null> {
  const path = join(ctx.recordWorktree, roomConfigPath(roomId));
  if (!(await exists(path))) return null;
  return parseRoomConfig(await readFile(path, "utf8"));
}
