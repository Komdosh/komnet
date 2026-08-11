import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  MAIN_REF,
  decisionPath,
  digestPath,
  messagePath,
  roomDir,
  roomRef,
  sealLockPath,
  slugify,
  type Message,
} from "@komnet/protocol";

import type { Repo } from "../git/repo.ts";
import type { Layout } from "../layout.ts";
import { RoomStore } from "../room/store.ts";
import { renderDecision, renderDigest } from "./digest.ts";

/**
 * Remote NAME, as opposed to its URL.
 *
 * These are not interchangeable: `refs/remotes/<name>/…` and `git push <name>`
 * need the name, while a fetch may take either. Conflating them silently builds
 * refspecs like `refs/remotes/https:/example.com/repo.git/room/x`.
 */
const REMOTE = "origin";

export interface SealPolicy {
  windowDays: number;
  windowMessages: number;
  minIntervalHours: number;
  /** Lease length. A holder that dies leaves a lock that expires rather than wedging the room. */
  lockLeaseMinutes: number;
}

export const DEFAULT_SEAL_POLICY: SealPolicy = {
  windowDays: 30,
  windowMessages: 500,
  minIntervalHours: 24,
  lockLeaseMinutes: 15,
};

export interface SealDecision {
  roomId: string;
  shouldSeal: boolean;
  reason: string;
  /** Messages outside the window, oldest first. */
  toSeal: Message[];
  keeping: number;
}

export interface SealResult {
  roomId: string;
  sealed: number;
  kept: number;
  digest: string | null;
  decisionsPromoted: number;
  /** Set when the seal did not run; `sealed` is then 0. */
  skipped?: string;
}

interface LockRecord {
  v: number;
  holder: string;
  acquired_at: string;
  expires_at: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compaction (docs/design/06-retention-and-sealing.md).
 *
 * Merge the room branch into `main`, write a digest, promote decisions, then
 * empty the raw messages out of both trees. The merge is what makes the pruning
 * safe: once the sealed commits are reachable from `main`, deleting the files
 * costs nothing — they stay in history forever.
 *
 * Every step is idempotent, so an interrupted seal is simply re-run.
 */
export class Sealer {
  private readonly repo: Repo;
  private readonly layout: Layout;
  private readonly networkId: string;
  private readonly agentId: string;
  /** Fetch source. Push and refspec destinations use REMOTE. */
  private readonly remoteUrl: string;
  private readonly log: (message: string) => void;

  constructor(init: {
    repo: Repo;
    layout: Layout;
    networkId: string;
    agentId: string;
    remote: string;
    log?: (message: string) => void;
  }) {
    this.repo = init.repo;
    this.layout = init.layout;
    this.networkId = init.networkId;
    this.agentId = init.agentId;
    this.remoteUrl = init.remote;
    this.log = init.log ?? (() => undefined);
  }

  private roomWorktree(roomId: string): string {
    return this.layout.roomWorktree(this.networkId, roomId);
  }

  private get recordWorktree(): string {
    return this.layout.recordWorktree(this.networkId);
  }

  /** Which messages fall outside the window, without touching anything. */
  async decide(roomId: string, policy: SealPolicy = DEFAULT_SEAL_POLICY): Promise<SealDecision> {
    const worktree = this.roomWorktree(roomId);
    if (!(await exists(worktree))) {
      return {
        roomId,
        shouldSeal: false,
        reason: "room not materialised here",
        toSeal: [],
        keeping: 0,
      };
    }

    const messages = await new RoomStore(worktree, roomId).readAll(() => undefined);
    const cutoff = Date.now() - policy.windowDays * 24 * 60 * 60 * 1000;

    // Two independent bounds; whichever bites first decides. Age keeps a quiet
    // room from hoarding, and count keeps a busy one from exploding inside a day.
    const tooOld = messages.filter((m) => Date.parse(m.header.ts) < cutoff);
    const overflow =
      messages.length > policy.windowMessages
        ? messages.slice(0, messages.length - policy.windowMessages)
        : [];

    const sealSet = new Map<string, Message>();
    for (const m of [...tooOld, ...overflow]) sealSet.set(m.header.id, m);
    const toSeal = [...sealSet.values()].sort((a, b) => (a.header.id < b.header.id ? -1 : 1));

    if (toSeal.length === 0) {
      return {
        roomId,
        shouldSeal: false,
        reason: `nothing outside the window (${String(messages.length)} message(s) held)`,
        toSeal: [],
        keeping: messages.length,
      };
    }

    return {
      roomId,
      shouldSeal: true,
      reason:
        tooOld.length > 0
          ? `${String(toSeal.length)} message(s) older than ${String(policy.windowDays)}d`
          : `${String(toSeal.length)} message(s) over the ${String(policy.windowMessages)}-message window`,
      toSeal,
      keeping: messages.length - toSeal.length,
    };
  }

  // ------------------------------------------------------------------- lock

  private async readLock(worktree: string, roomId: string): Promise<LockRecord | null> {
    const path = join(worktree, sealLockPath(roomId));
    try {
      return JSON.parse(await readFile(path, "utf8")) as LockRecord;
    } catch {
      return null;
    }
  }

  /**
   * Acquire the seal lock by compare-and-swap over git: write the lock file and
   * push. A rejected push means somebody else won the race — the remote's ref
   * update is already atomic, so no lock service is needed (spec §11).
   */
  private async acquireLock(roomId: string, policy: SealPolicy): Promise<boolean> {
    const worktree = this.roomWorktree(roomId);
    const ref = roomRef(roomId);

    for (let attempt = 0; attempt < 3; attempt++) {
      await this.repo.fetch(this.remoteUrl, [`+refs/heads/${ref}:refs/remotes/${REMOTE}/${ref}`]);
      await this.repo.fastForward(worktree, `refs/remotes/${REMOTE}/${ref}`);

      const existing = await this.readLock(worktree, roomId);
      if (existing !== null && Date.parse(existing.expires_at) > Date.now()) {
        this.log(`[${roomId}] seal lock held by ${existing.holder} until ${existing.expires_at}`);
        return false;
      }
      if (existing !== null) {
        this.log(`[${roomId}] stealing an expired seal lock from ${existing.holder}`);
      }

      const now = new Date();
      const record: LockRecord = {
        v: 1,
        holder: this.agentId,
        acquired_at: now.toISOString(),
        expires_at: new Date(now.getTime() + policy.lockLeaseMinutes * 60_000).toISOString(),
      };

      const path = join(worktree, sealLockPath(roomId));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      await this.repo.commitAll(worktree, `komnet: acquire seal lock for ${roomId}`);

      try {
        await this.repo.pushPreservingMerges(worktree, ref, {
          remote: REMOTE,
          maxAttempts: 1,
        });
        return true;
      } catch {
        // Lost the CAS. Reset and look again — the winner's lock is now visible.
        await this.repo.runner
          .run(["reset", "--hard", `refs/remotes/${REMOTE}/${ref}`], { cwd: worktree })
          .catch(() => undefined);
      }
    }
    return false;
  }

  private async releaseLock(roomId: string): Promise<void> {
    const worktree = this.roomWorktree(roomId);
    const ref = roomRef(roomId);
    const path = sealLockPath(roomId);
    if (!(await exists(join(worktree, path)))) return;

    await this.repo.removePaths(worktree, [path]);
    await this.repo.commitAll(worktree, `komnet: release seal lock for ${roomId}`);
    await this.repo
      .pushPreservingMerges(worktree, ref, { remote: REMOTE })
      .catch((error: unknown) => {
        // A stuck lock expires on its own, so this is a warning, not a failure.
        this.log(`[${roomId}] could not push lock release: ${String(error)}`);
      });
  }

  // ------------------------------------------------------------------- seal

  async seal(roomId: string, policy: SealPolicy = DEFAULT_SEAL_POLICY): Promise<SealResult> {
    const decision = await this.decide(roomId, policy);
    if (!decision.shouldSeal) {
      return {
        roomId,
        sealed: 0,
        kept: decision.keeping,
        digest: null,
        decisionsPromoted: 0,
        skipped: decision.reason,
      };
    }

    if (!(await this.acquireLock(roomId, policy))) {
      return {
        roomId,
        sealed: 0,
        kept: decision.keeping,
        digest: null,
        decisionsPromoted: 0,
        skipped: "another node holds the seal lock",
      };
    }

    try {
      return await this.run(roomId, decision, policy);
    } finally {
      await this.releaseLock(roomId);
    }
  }

  private async run(
    roomId: string,
    decision: SealDecision,
    policy: SealPolicy,
  ): Promise<SealResult> {
    const ref = roomRef(roomId);
    const record = this.recordWorktree;
    const room = this.roomWorktree(roomId);

    // Re-decide under the lock: messages may have arrived between the first
    // look and winning the race.
    const fresh = await this.decide(roomId, policy);
    const toSeal = fresh.shouldSeal ? fresh.toSeal : decision.toSeal;

    // 1. main up to date, then merge the room in. THIS is what makes the
    //    pruning safe — after it, every sealed commit is reachable from main.
    await this.repo.fetch(this.remoteUrl, [`+refs/heads/main:refs/remotes/${REMOTE}/main`]);
    await this.repo.fastForward(record, `refs/remotes/${REMOTE}/main`);

    const related = await this.repo.hasCommonAncestor(MAIN_REF, ref);
    await this.repo.merge(record, ref, {
      allowUnrelatedHistories: !related,
      message: `komnet: seal ${roomId} (${String(toSeal.length)} message(s))`,
    });

    // 2. Promote decisions before anything is deleted.
    const promoted = await this.promoteDecisions(record, roomId, toSeal);

    // 3. Digest.
    const period = periodOf(toSeal);
    const digestRel = await this.freeDigestPath(record, roomId, period);
    const digestAbs = join(record, digestRel);
    await mkdir(dirname(digestAbs), { recursive: true });
    await writeFile(
      digestAbs,
      renderDigest({
        roomId,
        period,
        messages: toSeal,
        gitRange: `${MAIN_REF}`,
        decisions: promoted,
      }),
      "utf8",
    );

    // 4. main carries the RECORD, not the live log — so every raw message goes,
    //    not only the sealed ones. History keeps them all.
    const allOnMain = await this.listMessagePaths(record, roomId);
    await this.repo.removePaths(record, allOnMain);
    await this.repo.commitAll(record, `komnet: digest ${roomId} ${period}`);
    await this.repo.pushPreservingMerges(record, MAIN_REF, { remote: REMOTE });

    // 5. Prune the sealed messages from the live branch, keeping the window.
    const sealedPaths = toSeal.map((m) => messagePath(m.header));
    await this.repo.removePaths(room, sealedPaths);
    await this.repo.commitAll(room, `komnet: prune ${String(toSeal.length)} sealed message(s)`);
    await this.repo.pushPreservingMerges(room, ref, { remote: REMOTE });

    this.log(`[${roomId}] sealed ${String(toSeal.length)} message(s) → ${digestRel}`);
    return {
      roomId,
      sealed: toSeal.length,
      kept: fresh.keeping,
      digest: digestRel,
      decisionsPromoted: promoted.length,
    };
  }

  /** Copy `kind: decision` messages into `decisions/`, which is never pruned. */
  private async promoteDecisions(
    record: string,
    roomId: string,
    messages: readonly Message[],
  ): Promise<{ seq: number; title: string; path: string }[]> {
    const decisions = messages.filter((m) => m.header.kind === "decision");
    if (decisions.length === 0) return [];

    let seq = await this.nextDecisionSeq(record, roomId);
    const written: { seq: number; title: string; path: string }[] = [];

    for (const message of decisions) {
      const title =
        message.body
          .trim()
          .split("\n")[0]
          ?.replace(/^#+\s*/, "") ?? "decision";
      const slug = slugify(title) ?? `decision-${String(seq)}`;
      const rel = decisionPath(roomId, seq, slug);
      const abs = join(record, rel);
      if (await exists(abs)) continue; // already promoted by an earlier attempt

      await mkdir(dirname(abs), { recursive: true });
      await writeFile(
        abs,
        renderDecision({
          seq,
          title,
          // Attribution stays with the human when a person authored it — a
          // decision must remain traceable to who actually made it.
          decidedBy:
            message.header.authorKind === "human" ? message.header.from : message.header.from,
          decidedAt: message.header.ts,
          sourceMessage: message.header.id,
          body: message.body,
        }),
        "utf8",
      );
      written.push({ seq, title, path: rel });
      seq += 1;
    }
    return written;
  }

  private async nextDecisionSeq(record: string, roomId: string): Promise<number> {
    const dir = join(record, roomDir(roomId), "decisions");
    try {
      const entries = await readdir(dir);
      const highest = entries
        .map((name) => Number(/^(\d{4})-/.exec(name)?.[1] ?? 0))
        .reduce((a, b) => Math.max(a, b), 0);
      return highest + 1;
    } catch {
      return 1;
    }
  }

  /**
   * A free digest filename for the period.
   *
   * Several seals can land in one month, so a second seal must not overwrite the
   * first month's digest and lose it.
   */
  private async freeDigestPath(record: string, roomId: string, period: string): Promise<string> {
    const base = digestPath(roomId, period);
    if (!(await exists(join(record, base)))) return base;
    for (let n = 2; n < 1000; n++) {
      const candidate = base.replace(/\.md$/, `-${String(n)}.md`);
      if (!(await exists(join(record, candidate)))) return candidate;
    }
    throw new Error(`cannot find a free digest name for ${roomId} ${period}`);
  }

  private async listMessagePaths(worktree: string, roomId: string): Promise<string[]> {
    return await new RoomStore(worktree, roomId).listMessagePaths();
  }
}

function periodOf(messages: readonly Message[]): string {
  const last = messages[messages.length - 1];
  const date = last === undefined ? new Date() : new Date(last.header.ts);
  return `${String(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
