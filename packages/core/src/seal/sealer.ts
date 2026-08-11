import { createHash, randomUUID } from "node:crypto";
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
  sealTransactionPath,
  slugify,
  type Message,
} from "@komnet/protocol";

import type { Repo } from "../git/repo.ts";
import type { Layout } from "../layout.ts";
import { RoomStore } from "../room/store.ts";
import { renderDecision, renderDigest } from "./digest.ts";
import { unresolvedMessages } from "./unresolved.ts";

/** Remote name. Fetch may use the configured URL; refs and pushes need the name. */
const REMOTE = "origin";

export interface SealPolicy {
  windowDays: number;
  windowMessages: number;
  minIntervalHours: number;
  /** Lease length. A dead holder leaves a lock that expires rather than wedging the room. */
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
  /** Safe-to-prune messages outside the window, oldest first. */
  toSeal: Message[];
  keeping: number;
  /** Open `needs` items deliberately kept even when they exceed the nominal window. */
  preserved: number;
}

export interface SealResult {
  roomId: string;
  sealed: number;
  kept: number;
  /** First digest, retained for API compatibility. */
  digest: string | null;
  /** One deterministic digest per calendar period touched by the transaction. */
  digests: string[];
  decisionsPromoted: number;
  /** Set when the seal did not run; `sealed` is then 0. */
  skipped?: string;
}

interface LockRecord {
  v: number;
  holder: string;
  token?: string;
  acquired_at: string;
  expires_at: string;
}

interface SealBatch {
  period: string;
  message_ids: string[];
}

interface SealTransaction {
  v: 1;
  id: string;
  created_at: string;
  source_head: string;
  message_ids: string[];
  open_question_ids: string[];
  decision_ids: string[];
  batches: SealBatch[];
}

interface PreparedTransaction {
  transaction: SealTransaction;
  messages: Message[];
  openQuestions: Message[];
  allMessages: Message[];
}

interface PromotedDecision {
  seq: number;
  title: string;
  path: string;
  sourceMessage: string;
  newlyWritten: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function chronological(messages: readonly Message[]): Message[] {
  return [...messages].sort((a, b) => {
    const byTime = Date.parse(a.header.ts) - Date.parse(b.header.ts);
    if (byTime !== 0) return byTime;
    return a.header.id < b.header.id ? -1 : a.header.id > b.header.id ? 1 : 0;
  });
}

function protectedOpenIds(messages: readonly Message[]): Set<string> {
  const byId = new Map(messages.map((message) => [message.header.id, message]));
  const protectedIds = new Set<string>();
  for (const open of unresolvedMessages(messages)) {
    let current: Message | undefined = open;
    while (current !== undefined && !protectedIds.has(current.header.id)) {
      protectedIds.add(current.header.id);
      const parentId: string | undefined = current.header.inReplyTo;
      current = parentId === undefined ? undefined : byId.get(parentId);
    }
  }
  return protectedIds;
}

function periodOf(message: Message): string {
  const date = new Date(message.header.ts);
  return `${String(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function transactionId(roomId: string, messageIds: readonly string[]): string {
  return createHash("sha256")
    .update(roomId)
    .update("\0")
    .update(messageIds.join("\0"))
    .digest("hex")
    .slice(0, 16);
}

function batchesFor(messages: readonly Message[]): SealBatch[] {
  const groups = new Map<string, string[]>();
  for (const message of messages) {
    const period = periodOf(message);
    const group = groups.get(period);
    if (group === undefined) groups.set(period, [message.header.id]);
    else group.push(message.header.id);
  }
  return [...groups].map(([period, message_ids]) => ({ period, message_ids }));
}

function digestPaths(roomId: string, transaction: SealTransaction): string[] {
  return transaction.batches.map((batch) => digestPath(roomId, batch.period, transaction.id));
}

/**
 * Compaction is a resumable transaction across a room branch and `main`.
 *
 * The durable room-side transaction fixes the message set before `main` is
 * touched. The room is pruned only after the merge, decisions, and digests are
 * durable on `main`. A retry therefore resumes the same set instead of making a
 * new boundary decision against half-completed state.
 */
export class Sealer {
  private readonly repo: Repo;
  private readonly layout: Layout;
  private readonly networkId: string;
  private readonly agentId: string;
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

  /** Which messages may safely leave the live window, without touching anything. */
  async decide(roomId: string, policy: SealPolicy = DEFAULT_SEAL_POLICY): Promise<SealDecision> {
    const worktree = this.roomWorktree(roomId);
    if (!(await exists(worktree))) {
      return {
        roomId,
        shouldSeal: false,
        reason: "room not materialised here",
        toSeal: [],
        keeping: 0,
        preserved: 0,
      };
    }

    // RoomStore returns thread order for reading. Retention is a time boundary,
    // so it must independently restore chronological order before slicing.
    const messages = chronological(await new RoomStore(worktree, roomId).readAll(() => undefined));
    const pending = await this.readTransaction(roomId);
    if (pending !== null) {
      const byId = new Map(messages.map((message) => [message.header.id, message]));
      const present = pending.message_ids.flatMap((id) => {
        const message = byId.get(id);
        return message === undefined ? [] : [message];
      });
      if (present.length !== 0 && present.length !== pending.message_ids.length) {
        throw new Error(
          `seal transaction ${pending.id} is only partially pruned; refusing ambiguous recovery`,
        );
      }
      return {
        roomId,
        shouldSeal: true,
        reason: `resume pending seal transaction ${pending.id}`,
        toSeal: present,
        keeping: messages.length - present.length,
        preserved: pending.open_question_ids.filter((id) => byId.has(id)).length,
      };
    }

    const cutoff = Date.now() - policy.windowDays * 24 * 60 * 60 * 1000;
    const tooOld = messages.filter((message) => Date.parse(message.header.ts) < cutoff);
    const overflow =
      messages.length > policy.windowMessages
        ? messages.slice(0, messages.length - policy.windowMessages)
        : [];

    const candidates = new Map<string, Message>();
    for (const message of [...tooOld, ...overflow]) {
      candidates.set(message.header.id, message);
    }

    // An open item and its available parent chain are a safety exception to the
    // count/age caps. They remain raw so late and offline peers can receive the
    // request with enough context to answer it.
    const openIds = protectedOpenIds(messages);
    const toSeal = chronological(
      [...candidates.values()].filter((message) => !openIds.has(message.header.id)),
    );
    const preserved = [...candidates.keys()].filter((id) => openIds.has(id)).length;

    if (toSeal.length === 0) {
      const protectedReason =
        preserved === 0
          ? ""
          : `; ${String(preserved)} unresolved item(s) carried forward beyond the nominal window`;
      return {
        roomId,
        shouldSeal: false,
        reason: `nothing safe outside the window (${String(messages.length)} message(s) held${protectedReason})`,
        toSeal: [],
        keeping: messages.length,
        preserved,
      };
    }

    const trigger =
      tooOld.length > 0
        ? `${String(toSeal.length)} message(s) older than ${String(policy.windowDays)}d`
        : `${String(toSeal.length)} message(s) over the ${String(policy.windowMessages)}-message window`;
    return {
      roomId,
      shouldSeal: true,
      reason:
        preserved === 0
          ? trigger
          : `${trigger}; preserving ${String(preserved)} unresolved item(s)`,
      toSeal,
      keeping: messages.length - toSeal.length,
      preserved,
    };
  }

  /** Pending transactions are recovery work and bypass the normal seal cadence. */
  async hasPendingTransaction(roomId: string): Promise<boolean> {
    return (await this.readTransaction(roomId)) !== null;
  }

  // ------------------------------------------------------------------- lock

  private parseLock(raw: string, source: string): LockRecord {
    const value = JSON.parse(raw) as Partial<LockRecord>;
    if (
      typeof value.v !== "number" ||
      typeof value.holder !== "string" ||
      typeof value.acquired_at !== "string" ||
      typeof value.expires_at !== "string" ||
      (value.token !== undefined && typeof value.token !== "string") ||
      !Number.isFinite(Date.parse(value.acquired_at)) ||
      !Number.isFinite(Date.parse(value.expires_at))
    ) {
      throw new Error(`malformed seal lock at ${source}`);
    }
    return value as LockRecord;
  }

  private async readLocalLock(worktree: string, roomId: string): Promise<LockRecord | null> {
    const path = join(worktree, sealLockPath(roomId));
    if (!(await exists(path))) return null;
    return this.parseLock(await readFile(path, "utf8"), path);
  }

  private async readRemoteLock(roomId: string): Promise<LockRecord | null> {
    const ref = `refs/remotes/${REMOTE}/${roomRef(roomId)}`;
    const raw = await this.repo.readFile(ref, sealLockPath(roomId));
    return raw === null ? null : this.parseLock(raw, `${ref}:${sealLockPath(roomId)}`);
  }

  private async resetRoomToRemote(roomId: string): Promise<void> {
    const worktree = this.roomWorktree(roomId);
    const remoteRef = `refs/remotes/${REMOTE}/${roomRef(roomId)}`;
    await this.repo.runner.run(["reset", "--hard", remoteRef], { cwd: worktree });
  }

  private async acquireLock(roomId: string, policy: SealPolicy): Promise<LockRecord | null> {
    const worktree = this.roomWorktree(roomId);
    const ref = roomRef(roomId);
    const remoteRef = `refs/remotes/${REMOTE}/${ref}`;

    for (let attempt = 0; attempt < 3; attempt++) {
      await this.repo.fetch(this.remoteUrl, [`+refs/heads/${ref}:${remoteRef}`]);
      await this.repo.fastForward(worktree, remoteRef);

      const existing = await this.readLocalLock(worktree, roomId);
      if (existing !== null && Date.parse(existing.expires_at) > Date.now()) {
        if (existing.holder === this.agentId && existing.token !== undefined) {
          this.log(`[${roomId}] resuming seal lock ${existing.token}`);
          return existing;
        }
        this.log(`[${roomId}] seal lock held by ${existing.holder} until ${existing.expires_at}`);
        return null;
      }
      if (existing !== null) {
        this.log(`[${roomId}] stealing an expired seal lock from ${existing.holder}`);
      }

      const now = new Date();
      const record: LockRecord = {
        v: 2,
        holder: this.agentId,
        token: randomUUID(),
        acquired_at: now.toISOString(),
        expires_at: new Date(now.getTime() + policy.lockLeaseMinutes * 60_000).toISOString(),
      };
      const path = join(worktree, sealLockPath(roomId));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      await this.repo.commitAll(worktree, `komnet: acquire seal lock for ${roomId}`);

      if (await this.repo.pushCompareAndSwap(worktree, ref, REMOTE)) return record;

      // Only a non-fast-forward reaches here. Refresh before discarding our
      // losing lock commit; transport and auth failures have already surfaced.
      await this.repo.fetch(this.remoteUrl, [`+refs/heads/${ref}:${remoteRef}`]);
      await this.resetRoomToRemote(roomId);
    }
    return null;
  }

  private async renewLock(
    roomId: string,
    held: LockRecord,
    policy: SealPolicy,
  ): Promise<LockRecord> {
    if (held.token === undefined)
      throw new Error("cannot renew a legacy seal lock without a token");
    const worktree = this.roomWorktree(roomId);
    const ref = roomRef(roomId);
    const remoteRef = `refs/remotes/${REMOTE}/${ref}`;

    for (let attempt = 0; attempt < 5; attempt++) {
      await this.repo.fetch(this.remoteUrl, [`+refs/heads/${ref}:${remoteRef}`]);
      const remoteLock = await this.readRemoteLock(roomId);
      if (remoteLock?.token !== held.token) {
        throw new Error(`seal lock for ${roomId} was lost before compaction completed`);
      }
      await this.repo.fastForward(worktree, remoteRef);

      const now = new Date();
      const renewed: LockRecord = {
        ...held,
        expires_at: new Date(now.getTime() + policy.lockLeaseMinutes * 60_000).toISOString(),
      };
      const path = join(worktree, sealLockPath(roomId));
      await writeFile(path, `${JSON.stringify(renewed, null, 2)}\n`, "utf8");
      await this.repo.commitAll(worktree, `komnet: renew seal lock for ${roomId}`);
      if (await this.repo.pushCompareAndSwap(worktree, ref, REMOTE)) return renewed;
    }
    throw new Error(`could not renew seal lock for ${roomId} after 5 concurrent updates`);
  }

  private async assertLockHeld(roomId: string, held: LockRecord): Promise<void> {
    await this.repo.fetch(this.remoteUrl, [
      `+refs/heads/${roomRef(roomId)}:refs/remotes/${REMOTE}/${roomRef(roomId)}`,
    ]);
    const remote = await this.readRemoteLock(roomId);
    if (
      held.token === undefined ||
      remote?.token !== held.token ||
      Date.parse(remote.expires_at) <= Date.now()
    ) {
      throw new Error(`seal lock for ${roomId} is no longer valid`);
    }
  }

  private async releaseLock(
    roomId: string,
    held: LockRecord,
    clearTransaction: boolean,
  ): Promise<void> {
    if (held.token === undefined) return;
    const worktree = this.roomWorktree(roomId);
    const ref = roomRef(roomId);
    const remoteRef = `refs/remotes/${REMOTE}/${ref}`;

    for (let attempt = 0; attempt < 5; attempt++) {
      await this.repo.fetch(this.remoteUrl, [`+refs/heads/${ref}:${remoteRef}`]);
      const remoteLock = await this.readRemoteLock(roomId);
      if (remoteLock?.token !== held.token) {
        // Never let an expired holder delete its successor's lock. Also discard
        // local delete commits so a later ordinary push cannot leak them out.
        await this.resetRoomToRemote(roomId);
        return;
      }

      await this.repo.fastForward(worktree, remoteRef);
      const paths = [sealLockPath(roomId)];
      if (clearTransaction) paths.push(sealTransactionPath(roomId));
      await this.repo.removePaths(worktree, paths);
      await this.repo.commitAll(worktree, `komnet: release seal lock for ${roomId}`);
      if (await this.repo.pushCompareAndSwap(worktree, ref, REMOTE)) return;
    }
    this.log(`[${roomId}] could not release seal lock after 5 concurrent updates`);
  }

  // ------------------------------------------------------------- transaction

  private parseTransaction(raw: string, roomId: string, source: string): SealTransaction {
    const value = JSON.parse(raw) as Partial<SealTransaction>;
    const validBatch = (batch: SealBatch): boolean =>
      /^\d{4}-\d{2}$/.test(batch.period) &&
      Array.isArray(batch.message_ids) &&
      batch.message_ids.every((id) => typeof id === "string");
    if (
      value.v !== 1 ||
      typeof value.id !== "string" ||
      !/^[0-9a-f]{16}$/.test(value.id) ||
      typeof value.created_at !== "string" ||
      !Number.isFinite(Date.parse(value.created_at)) ||
      typeof value.source_head !== "string" ||
      !/^[0-9a-f]{40,64}$/.test(value.source_head) ||
      !Array.isArray(value.message_ids) ||
      !value.message_ids.every((id) => typeof id === "string") ||
      !Array.isArray(value.open_question_ids) ||
      !value.open_question_ids.every((id) => typeof id === "string") ||
      !Array.isArray(value.decision_ids) ||
      !value.decision_ids.every((id) => typeof id === "string") ||
      !Array.isArray(value.batches) ||
      !value.batches.every((batch) => validBatch(batch as SealBatch))
    ) {
      throw new Error(`malformed seal transaction at ${source}`);
    }

    const transaction = value as SealTransaction;
    const ids = transaction.batches.flatMap((batch) => batch.message_ids);
    if (
      new Set(transaction.message_ids).size !== transaction.message_ids.length ||
      ids.length !== transaction.message_ids.length ||
      ids.some((id, index) => id !== transaction.message_ids[index]) ||
      transactionId(roomId, transaction.message_ids) !== transaction.id
    ) {
      throw new Error(`inconsistent seal transaction at ${source}`);
    }
    return transaction;
  }

  private async readTransaction(roomId: string): Promise<SealTransaction | null> {
    const path = join(this.roomWorktree(roomId), sealTransactionPath(roomId));
    if (!(await exists(path))) return null;
    return this.parseTransaction(await readFile(path, "utf8"), roomId, path);
  }

  private async prepareTransaction(
    roomId: string,
    policy: SealPolicy,
  ): Promise<PreparedTransaction | SealDecision> {
    const room = this.roomWorktree(roomId);
    const allMessages = chronological(await new RoomStore(room, roomId).readAll(() => undefined));
    const byId = new Map(allMessages.map((message) => [message.header.id, message]));
    const existing = await this.readTransaction(roomId);

    if (existing !== null) {
      const present = existing.message_ids.flatMap((id) => {
        const message = byId.get(id);
        return message === undefined ? [] : [message];
      });
      if (present.length !== 0 && present.length !== existing.message_ids.length) {
        throw new Error(
          `seal transaction ${existing.id} is only partially pruned; refusing ambiguous recovery`,
        );
      }
      const openQuestions = existing.open_question_ids.flatMap((id) => {
        const message = byId.get(id);
        return message === undefined ? [] : [message];
      });
      return { transaction: existing, messages: present, openQuestions, allMessages };
    }

    // Re-decide only after the distributed lock is held. The pre-lock decision
    // is merely a cheap trigger and must never be reused after another sealer ran.
    const decision = await this.decide(roomId, policy);
    if (!decision.shouldSeal) return decision;

    const sourceHead = await this.repo.resolveRef(`refs/heads/${roomRef(roomId)}`);
    if (sourceHead === null) throw new Error(`cannot resolve ${roomRef(roomId)} for sealing`);
    const messageIds = decision.toSeal.map((message) => message.header.id);
    const openQuestions = unresolvedMessages(allMessages);
    const transaction: SealTransaction = {
      v: 1,
      id: transactionId(roomId, messageIds),
      created_at: new Date().toISOString(),
      source_head: sourceHead,
      message_ids: messageIds,
      open_question_ids: openQuestions.map((message) => message.header.id),
      decision_ids: decision.toSeal
        .filter((message) => message.header.kind === "decision")
        .map((message) => message.header.id),
      batches: batchesFor(decision.toSeal),
    };

    const path = join(room, sealTransactionPath(roomId));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(transaction, null, 2)}\n`, "utf8");
    await this.repo.commitAll(room, `komnet: plan seal ${transaction.id} for ${roomId}`);
    await this.repo.pushPreservingMerges(room, roomRef(roomId), { remote: REMOTE });

    return {
      transaction,
      messages: decision.toSeal,
      openQuestions,
      allMessages,
    };
  }

  private async recoverCompleted(
    roomId: string,
    prepared: PreparedTransaction,
  ): Promise<SealResult> {
    const paths = digestPaths(roomId, prepared.transaction);
    await this.repo.fetch(this.remoteUrl, [`+refs/heads/main:refs/remotes/${REMOTE}/main`]);
    for (const path of paths) {
      if ((await this.repo.readFile(`refs/remotes/${REMOTE}/main`, path)) === null) {
        throw new Error(
          `seal transaction ${prepared.transaction.id} lost its room messages before ${path} became durable`,
        );
      }
    }
    return {
      roomId,
      sealed: prepared.transaction.message_ids.length,
      kept: prepared.allMessages.length,
      digest: paths[0] ?? null,
      digests: paths,
      decisionsPromoted: prepared.transaction.decision_ids.length,
    };
  }

  // ------------------------------------------------------------------- seal

  async seal(roomId: string, policy: SealPolicy = DEFAULT_SEAL_POLICY): Promise<SealResult> {
    const pending = await this.readTransaction(roomId);
    const initial = await this.decide(roomId, policy);
    if (!initial.shouldSeal && pending === null) return this.skipped(initial);

    const held = await this.acquireLock(roomId, policy);
    if (held === null) {
      return {
        roomId,
        sealed: 0,
        kept: initial.keeping,
        digest: null,
        digests: [],
        decisionsPromoted: 0,
        skipped: "another node holds the seal lock",
      };
    }

    let clearTransaction = false;
    try {
      const prepared = await this.prepareTransaction(roomId, policy);
      if ("shouldSeal" in prepared) return this.skipped(prepared);

      if (prepared.messages.length === 0) {
        const recovered = await this.recoverCompleted(roomId, prepared);
        clearTransaction = true;
        return recovered;
      }

      const renewed = await this.renewLock(roomId, held, policy);
      const result = await this.run(roomId, prepared, renewed, policy);
      clearTransaction = true;
      return result;
    } finally {
      await this.releaseLock(roomId, held, clearTransaction).catch((error: unknown) => {
        this.log(`[${roomId}] could not release seal lock: ${String(error)}`);
      });
    }
  }

  private skipped(decision: SealDecision): SealResult {
    return {
      roomId: decision.roomId,
      sealed: 0,
      kept: decision.keeping,
      digest: null,
      digests: [],
      decisionsPromoted: 0,
      skipped: decision.reason,
    };
  }

  private async run(
    roomId: string,
    prepared: PreparedTransaction,
    held: LockRecord,
    policy: SealPolicy,
  ): Promise<SealResult> {
    const ref = roomRef(roomId);
    const record = this.recordWorktree;
    const room = this.roomWorktree(roomId);
    const transaction = prepared.transaction;
    const byId = new Map(prepared.messages.map((message) => [message.header.id, message]));

    // 1. Merge first. This is the data-safety boundary: after the main push,
    // every raw source commit is permanently reachable even when room files go.
    await this.repo.fetch(this.remoteUrl, [`+refs/heads/main:refs/remotes/${REMOTE}/main`]);
    await this.repo.syncPreservingMerges(record, `refs/remotes/${REMOTE}/main`);
    const related = await this.repo.hasCommonAncestor(MAIN_REF, ref);
    await this.repo.merge(record, ref, {
      allowUnrelatedHistories: !related,
      message: `komnet: seal ${roomId} transaction ${transaction.id}`,
      deleteConflicts: [sealLockPath(roomId), sealTransactionPath(roomId)],
    });

    // 2. Promote decisions idempotently by source_message, not by a sequence
    // guessed from the current tree. A retry must link the existing record.
    const promoted = await this.promoteDecisions(record, roomId, prepared.messages);

    // 3. Write deterministic per-period digests. The transaction id makes the
    // path stable across retries and lets multiple seals in one month coexist.
    const writtenDigests: string[] = [];
    for (const batch of transaction.batches) {
      const messages = batch.message_ids.map((id) => {
        const message = byId.get(id);
        if (message === undefined) throw new Error(`seal transaction is missing message ${id}`);
        return message;
      });
      const digestRel = digestPath(roomId, batch.period, transaction.id);
      const digestAbs = join(record, digestRel);
      const content = renderDigest({
        roomId,
        period: batch.period,
        sealId: transaction.id,
        messages,
        gitRange: transaction.source_head,
        sourcePaths: messages.map((message) => messagePath(message.header)),
        openQuestions: prepared.openQuestions,
        decisions: promoted
          .filter((decision) => batch.message_ids.includes(decision.sourceMessage))
          .map(({ seq, title, path }) => ({ seq, title, path })),
      });
      if (await exists(digestAbs)) {
        const existing = await readFile(digestAbs, "utf8");
        if (existing !== content) {
          throw new Error(
            `digest collision for seal transaction ${transaction.id} at ${digestRel}`,
          );
        }
      } else {
        await mkdir(dirname(digestAbs), { recursive: true });
        await writeFile(digestAbs, content, "utf8");
      }
      writtenDigests.push(digestRel);
    }

    // Main is the compact record, not a second live log. Remove every raw
    // message introduced by the merge and all ephemeral seal control files.
    const allOnMain = await this.listMessagePaths(record, roomId);
    await this.repo.removePaths(record, [
      ...allOnMain,
      sealLockPath(roomId),
      sealTransactionPath(roomId),
    ]);
    await this.repo.commitAll(record, `komnet: record seal transaction ${transaction.id}`);

    // A stale holder must not publish after a successor has stolen its lease.
    await this.assertLockHeld(roomId, held);
    await this.repo.pushPreservingMerges(record, MAIN_REF, { remote: REMOTE });

    // Renew after main is durable and before the destructive room-side phase.
    await this.renewLock(roomId, held, policy);
    const sealedPaths = prepared.messages.map((message) => messagePath(message.header));
    await this.repo.removePaths(room, sealedPaths);
    await this.repo.commitAll(
      room,
      `komnet: prune seal transaction ${transaction.id} (${String(sealedPaths.length)} message(s))`,
    );
    await this.repo.pushPreservingMerges(room, ref, { remote: REMOTE });

    const kept = (await new RoomStore(room, roomId).listMessagePaths()).length;
    this.log(
      `[${roomId}] sealed ${String(prepared.messages.length)} message(s) -> ${writtenDigests.join(", ")}`,
    );
    return {
      roomId,
      sealed: prepared.messages.length,
      kept,
      digest: writtenDigests[0] ?? null,
      digests: writtenDigests,
      decisionsPromoted: promoted.filter((decision) => decision.newlyWritten).length,
    };
  }

  /** Copy decision messages into the never-pruned permanent record. */
  private async promoteDecisions(
    record: string,
    roomId: string,
    messages: readonly Message[],
  ): Promise<PromotedDecision[]> {
    const decisions = messages.filter((message) => message.header.kind === "decision");
    if (decisions.length === 0) return [];

    const existing = await this.existingDecisionSources(record, roomId);
    let seq = await this.nextDecisionSeq(record, roomId);
    const promoted: PromotedDecision[] = [];

    for (const message of decisions) {
      const title =
        message.body
          .trim()
          .split("\n")[0]
          ?.replace(/^#+\s*/, "") ?? "decision";
      const prior = existing.get(message.header.id);
      if (prior !== undefined) {
        promoted.push({ ...prior, title, sourceMessage: message.header.id, newlyWritten: false });
        continue;
      }

      const slug = slugify(title) ?? `decision-${String(seq)}`;
      const rel = decisionPath(roomId, seq, slug);
      const abs = join(record, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(
        abs,
        renderDecision({
          seq,
          title,
          decidedBy: message.header.from,
          decidedAt: message.header.ts,
          sourceMessage: message.header.id,
          ...(message.header.inReplyTo === undefined
            ? {}
            : { supersedes: message.header.inReplyTo }),
          body: message.body,
        }),
        "utf8",
      );
      promoted.push({
        seq,
        title,
        path: rel,
        sourceMessage: message.header.id,
        newlyWritten: true,
      });
      seq += 1;
    }
    return promoted;
  }

  private async existingDecisionSources(
    record: string,
    roomId: string,
  ): Promise<Map<string, { seq: number; path: string }>> {
    const dir = join(record, roomDir(roomId), "decisions");
    const sources = new Map<string, { seq: number; path: string }>();
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return sources;
    }
    for (const name of entries.sort()) {
      if (!name.endsWith(".md")) continue;
      const raw = await readFile(join(dir, name), "utf8");
      const source = /^source_message:\s*(\S+)\s*$/m.exec(raw)?.[1];
      const seq = Number(/^(\d{4})-/.exec(name)?.[1] ?? 0);
      if (source !== undefined && seq > 0) {
        sources.set(source, {
          seq,
          path: `${roomDir(roomId)}/decisions/${name}`,
        });
      }
    }
    return sources;
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

  private async listMessagePaths(worktree: string, roomId: string): Promise<string[]> {
    return await new RoomStore(worktree, roomId).listMessagePaths();
  }
}
