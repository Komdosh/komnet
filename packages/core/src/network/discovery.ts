/**
 * Messages addressed to this agent in rooms it does NOT follow.
 *
 * Kept apart from sync on purpose — see the note on `discoverMentions`. It
 * shares nothing with the rest of the surface: no receipts, no inbox, no state
 * database, just the remote and this agent's own id.
 */

import { isMessagePath, parseMessage, roomRef } from "@komnet/protocol";

import type { DiscoveredMention } from "../network.ts";
import type { Repo } from "../git/repo.ts";

const REMOTE = "origin";

/** What discovery needs from the network, and nothing more. */
export interface DiscoveryContext {
  readonly agentId: string;
  readonly repo: Repo;
  readonly remote: string;
  /** Read live: a long-lived process picks up joins and leaves. */
  readonly subscriptions: readonly string[];
}

/**
 * Find messages addressed to this agent in rooms it does NOT follow.
 *
 * Routing only delivers within subscribed rooms, and the fetch scope is the
 * subscription list — so a message that mentions this agent by name in a room it
 * never joined is invisible. Nothing reports it, which makes "addressed to you"
 * quietly weaker than it sounds.
 *
 * Deliberately separate from `sync` and NOT added to the inbox. Sync's whole
 * economy is that one `ls-remote` says which subscribed rooms moved and nothing
 * else is fetched (ADR 0008); folding discovery in would fetch every room on the
 * network on every poll. This is the explicit, occasional question instead, and
 * it answers with "join this room", not by silently widening what the inbox
 * means.
 */
export async function discoverMentions(
  ctx: DiscoveryContext,
  options: { limitPerRoom?: number } = {},
): Promise<DiscoveredMention[]> {
  const limit = options.limitPerRoom ?? 25;
  const subscribed = new Set(ctx.subscriptions);
  const remote = await ctx.repo.lsRemoteHeads(ctx.remote);
  const found: DiscoveredMention[] = [];

  for (const [roomId, head] of remote.rooms) {
    if (subscribed.has(roomId)) continue;
    const ref = `refs/remotes/${REMOTE}/${roomRef(roomId)}`;
    try {
      await ctx.repo.fetch(ctx.remote, [`+refs/heads/${roomRef(roomId)}:${ref}`]);
    } catch {
      continue; // A room we cannot read is not a room we can report on.
    }

    // Message paths are timestamp-prefixed, so the newest are the last after a
    // plain sort — reading only the tail bounds the cost of looking.
    const paths = (await ctx.repo.addedSince(null, head, `rooms/${roomId}/`))
      .filter(isMessagePath)
      .sort()
      .slice(-limit);

    for (const path of paths) {
      const raw = await ctx.repo.readFile(head, path);
      if (raw === null) continue;
      try {
        const message = parseMessage(raw, path);
        if (message.header.from === ctx.agentId) continue;
        // Only a DIRECT mention: `@room` addresses subscribers, and this agent
        // is by definition not one of them here.
        if (!message.header.mentions.includes(ctx.agentId)) continue;
        found.push({
          room: roomId,
          id: message.header.id,
          from: message.header.from,
          ts: message.header.ts,
          needs: message.header.needs,
          kind: message.header.kind,
        });
      } catch {
        // Unreadable message: not something to report as a mention.
      }
    }
  }
  return found.sort((a, b) => b.id.localeCompare(a.id));
}
