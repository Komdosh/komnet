import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { isUlid } from "@komnet/protocol";

/**
 * Local record of work a person has agreed this agent may take on.
 *
 * **Deliberately not in `state.db`.** That database is a cache whose every row
 * is derivable from git and which is discarded wholesale on a schema bump
 * (docs/design/02-architecture.md §3). An approval is derivable from nothing —
 * it happened in a room, out loud, between a person and their agent — so
 * storing it there would mean a routine schema change silently revoked every
 * decision a person had made.
 *
 * It is also never published. An approval says "my human said I may do this",
 * which is a fact about this machine; writing it to the shared log would invite
 * other agents to read it as authority, and a remote peer must never be able to
 * satisfy a gate whose entire purpose is keeping its requests under local
 * control.
 */

export const APPROVAL_KINDS = ["task", "review"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export interface ApprovalRecord {
  kind: ApprovalKind;
  /** ULID of the task or review this approval unlocks. */
  id: string;
  room: string;
  /** RFC 3339 UTC. */
  approvedAt: string;
  /** What the person said, if anything. Free text, never interpreted. */
  note?: string;
}

interface ApprovalFile {
  v: number;
  approvals: ApprovalRecord[];
}

const FILE_VERSION = 1;

function isKind(value: unknown): value is ApprovalKind {
  return typeof value === "string" && (APPROVAL_KINDS as readonly string[]).includes(value);
}

/** Decode defensively: a corrupt file must fail closed, never open. */
function decode(raw: string): ApprovalRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // An unreadable file means "nothing is approved", so the gate holds and the
    // person is asked again. The opposite default would let a truncated write
    // wave work through.
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const entries = (parsed as Partial<ApprovalFile>).approvals;
  if (!Array.isArray(entries)) return [];

  const records: ApprovalRecord[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Partial<ApprovalRecord>;
    if (!isKind(record.kind)) continue;
    if (typeof record.id !== "string" || !isUlid(record.id)) continue;
    if (typeof record.room !== "string" || record.room.length === 0) continue;
    records.push({
      kind: record.kind,
      id: record.id,
      room: record.room,
      approvedAt:
        typeof record.approvedAt === "string" ? record.approvedAt : new Date(0).toISOString(),
      ...(typeof record.note === "string" ? { note: record.note } : {}),
    });
  }
  return records;
}

export class ApprovalStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async list(): Promise<ApprovalRecord[]> {
    try {
      return decode(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async has(kind: ApprovalKind, id: string): Promise<boolean> {
    return (await this.list()).some((record) => record.kind === kind && record.id === id);
  }

  /** Record one approval. Idempotent: approving twice is not an error. */
  async record(entry: Omit<ApprovalRecord, "approvedAt">): Promise<ApprovalRecord> {
    if (!isUlid(entry.id)) throw new TypeError(`not a ULID: ${entry.id}`);
    const existing = await this.list();
    const already = existing.find((record) => record.kind === entry.kind && record.id === entry.id);
    if (already !== undefined) return already;

    const record: ApprovalRecord = {
      kind: entry.kind,
      id: entry.id,
      room: entry.room,
      approvedAt: new Date().toISOString(),
      ...(entry.note === undefined ? {} : { note: entry.note }),
    };
    await this.write([...existing, record]);
    return record;
  }

  /** Withdraw an approval. Returns false when there was nothing to withdraw. */
  async revoke(kind: ApprovalKind, id: string): Promise<boolean> {
    const existing = await this.list();
    const remaining = existing.filter((record) => !(record.kind === kind && record.id === id));
    if (remaining.length === existing.length) return false;
    await this.write(remaining);
    return true;
  }

  private async write(records: readonly ApprovalRecord[]): Promise<void> {
    const file: ApprovalFile = { v: FILE_VERSION, approvals: [...records] };
    await mkdir(dirname(this.path), { recursive: true });
    // 0600: this records what a person permitted, and nothing else on the box
    // has any business reading or editing it.
    await writeFile(this.path, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}
