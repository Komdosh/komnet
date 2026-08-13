import { compareMessages, type Claim, type Message } from "@komnet/protocol";

/**
 * Who currently holds a resource, derived from append-only claim events.
 *
 * Same shape as every other komnet fact: events are immutable, ordering is by
 * ULID, and the current state is a reduction. Nothing here rewrites a shared
 * file, so two agents claiming at once produce two events rather than a
 * conflict — and the reduction picks the same winner on every machine.
 */
export interface ClaimStatus {
  resource: string;
  holder: string;
  /** When the winning hold was taken. */
  since: string;
  /** When it lapses without a renewal. */
  expiresAt: string;
  /** True once the deadline has passed: the resource is free again. */
  expired: boolean;
  /** What the holder said they were doing. */
  note: string;
  messageId: string;
  /**
   * Agents whose claim lost to the holder and have not since released.
   *
   * Reported rather than hidden: the loser must find out, and on a git
   * transport it may not know until its next sync.
   */
  contenders: string[];
}

/**
 * Reduce claim events into the current holder of each resource.
 *
 * The rules, in order:
 *  - a `held` event wins the resource when nobody holds it, or when the
 *    previous hold has expired, or when it renews the current holder's own;
 *  - a `released` event frees it, but only from its own holder;
 *  - a hold lapses on its own at `ts + ttl`, so an agent that crashed mid-build
 *    does not strand the resource forever. That expiry is the whole reason this
 *    beats the "BUILD-START / BUILD-DONE" convention it replaces.
 */
export function reduceClaims(messages: readonly Message[], now = Date.now()): ClaimStatus[] {
  const byResource = new Map<string, Message[]>();
  for (const message of messages) {
    const claim = message.header.claim;
    if (claim === undefined) continue;
    const bucket = byResource.get(claim.resource);
    if (bucket === undefined) byResource.set(claim.resource, [message]);
    else bucket.push(message);
  }

  const statuses: ClaimStatus[] = [];
  for (const [resource, events] of byResource) {
    events.sort((a, b) => compareMessages(a.header, b.header));

    let holder: ClaimStatus | null = null;
    const contenders: string[] = [];

    for (const event of events) {
      const claim = event.header.claim as Claim;
      const at = Date.parse(event.header.ts);
      if (!Number.isFinite(at)) continue;

      if (claim.action === "released") {
        // Only the holder may release, so a stray release cannot free someone
        // else's lock.
        if (holder !== null && holder.holder === claim.holder) holder = null;
        continue;
      }

      const heldUntil = holder === null ? 0 : Date.parse(holder.expiresAt);
      const free = holder === null || at >= heldUntil;
      const renewal = holder !== null && holder.holder === claim.holder;
      if (!free && !renewal) {
        if (!contenders.includes(claim.holder)) contenders.push(claim.holder);
        continue;
      }
      holder = {
        resource,
        holder: claim.holder,
        since: event.header.ts,
        expiresAt: new Date(at + claim.ttlSeconds * 1000).toISOString(),
        expired: false,
        note: event.body.trim(),
        messageId: event.header.id,
        contenders: [],
      };
      // Winning clears anyone who lost to the hold that just ended.
      contenders.length = 0;
    }

    if (holder === null) continue;
    const expired = now >= Date.parse(holder.expiresAt);
    statuses.push({ ...holder, expired, contenders: expired ? [] : [...contenders] });
  }

  return statuses.sort((a, b) => a.resource.localeCompare(b.resource));
}

/** The live holder of one resource, or null when it is free. */
export function currentHolder(
  statuses: readonly ClaimStatus[],
  resource: string,
): ClaimStatus | null {
  const status = statuses.find((candidate) => candidate.resource === resource);
  return status === undefined || status.expired ? null : status;
}
