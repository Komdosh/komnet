import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Message } from "@komnet/protocol";

/**
 * Local index over the repository.
 *
 * **This is a cache.** Every row here is derivable from git, and the file may
 * be deleted at any time: with no cursor for a room, the next `Network.sync`
 * sees `from: null`, walks that room's branch from its root, and refills both
 * tables. Nothing may exist only in sqlite, because the repository is the
 * source of truth (docs/design/02-architecture.md §3).
 *
 * The cost of that rebuild is real and worth stating: a room's whole live
 * window is re-delivered to the inbox, because "already drained" was itself
 * only cached. So discarding is correct but not free, and a schema bump is a
 * user-visible event (see `SCHEMA_VERSION`).
 *
 * `node:sqlite` is built into Node 26, so a real local index costs zero native
 * dependencies — which is what keeps installation from failing on a toolchain.
 */

export interface InboxItem {
  id: string;
  room: string;
  from: string;
  ts: string;
  kind: string;
  needs: string;
  priority: string;
  /** Thread root, so a draining agent can reply into the right conversation. */
  thread: string;
  /**
   * Header tags, carried on the row rather than re-read from git.
   *
   * This is what lets a long-running watcher classify an item — a handshake, a
   * relay — from the cache alone. Re-opening the message file to find out would
   * put git I/O in the hot loop of a process that polls forever.
   */
  tags: string[];
  path: string;
  body: string;
  processedAt: string | null;
}

export interface InboxQuery {
  room?: string;
  needs?: string;
  /** Match items carrying this header tag. */
  tag?: string;
  includeProcessed?: boolean;
  limit?: number;
}

/**
 * Bump on any schema change. Because this file is a cache and never a source of
 * truth, a mismatch is resolved by discarding and rebuilding from git rather
 * than by writing migrations.
 *
 * Discarding costs the user something, so a bump is not free: dropping
 * `cursors` alongside `inbox` makes the next sync re-walk each room from its
 * root and re-deliver its whole live window. Every bump belongs in the
 * changelog for that reason.
 *
 * 3 — `inbox.tags`, so a watcher can filter by tag without re-reading git.
 */
const SCHEMA_VERSION = "3";

const META_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const SCHEMA = `
-- Last processed head per room. Reading is a local act, so cursors never
-- become a write to shared state.
CREATE TABLE IF NOT EXISTS cursors (
  room TEXT PRIMARY KEY,
  head TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox (
  id           TEXT PRIMARY KEY,
  room         TEXT NOT NULL,
  sender       TEXT NOT NULL,
  ts           TEXT NOT NULL,
  kind         TEXT NOT NULL,
  needs        TEXT NOT NULL,
  priority     TEXT NOT NULL,
  thread       TEXT NOT NULL,
  -- JSON array, not a delimited string: tags are free-form text written on
  -- another machine, so any delimiter chosen here could appear inside one.
  tags         TEXT NOT NULL DEFAULT '[]',
  path         TEXT NOT NULL,
  body         TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS inbox_pending ON inbox (processed_at, room);
CREATE INDEX IF NOT EXISTS inbox_ts ON inbox (ts);
`;

export class StateDb {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(path: string): StateDb {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    // WAL keeps a read during a concurrent write from failing outright.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(META_SCHEMA);

    const row = db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as
      { value: string } | undefined;
    if (row !== undefined && row.value !== SCHEMA_VERSION) {
      // Discard rather than migrate: everything here is derivable from git, and
      // the next sync refills it.
      db.exec("DROP TABLE IF EXISTS inbox; DROP TABLE IF EXISTS cursors;");
    }
    db.exec(SCHEMA);
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schemaVersion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(SCHEMA_VERSION);
    return new StateDb(db);
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------------ cursors

  getHead(room: string): string | null {
    const row = this.db.prepare("SELECT head FROM cursors WHERE room = ?").get(room) as
      { head: string } | undefined;
    return row?.head ?? null;
  }

  setHead(room: string, head: string): void {
    this.db
      .prepare(
        "INSERT INTO cursors (room, head) VALUES (?, ?) ON CONFLICT(room) DO UPDATE SET head = excluded.head",
      )
      .run(room, head);
  }

  allHeads(): Map<string, string> {
    const rows = this.db.prepare("SELECT room, head FROM cursors").all() as {
      room: string;
      head: string;
    }[];
    return new Map(rows.map((r) => [r.room, r.head]));
  }

  forgetRoom(room: string): void {
    this.db.prepare("DELETE FROM cursors WHERE room = ?").run(room);
    this.db.prepare("DELETE FROM inbox WHERE room = ?").run(room);
  }

  // -------------------------------------------------------------------- inbox

  /**
   * Record a message as pending. Idempotent by message id, so re-syncing a ref
   * cannot duplicate an item or resurrect one already drained.
   */
  addToInbox(message: Message, path: string): void {
    this.db
      .prepare(
        `INSERT INTO inbox (id, room, sender, ts, kind, needs, priority, thread, tags, path, body, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        message.header.id,
        message.header.room,
        message.header.from,
        message.header.ts,
        message.header.kind,
        message.header.needs,
        message.header.priority,
        message.header.thread,
        JSON.stringify(message.header.tags),
        path,
        message.body,
      );
  }

  listInbox(query: InboxQuery = {}): InboxItem[] {
    const where: string[] = [];
    const params: string[] = [];
    if (query.includeProcessed !== true) where.push("processed_at IS NULL");
    if (query.room !== undefined) {
      where.push("room = ?");
      params.push(query.room);
    }
    if (query.needs !== undefined) {
      where.push("needs = ?");
      params.push(query.needs);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    // A tag match is applied in JS over the decoded array, so `LIMIT` has to
    // move with it — trimming in SQL first would return fewer matches than the
    // caller asked for, or none at all.
    const limitInSql = query.tag === undefined && query.limit !== undefined;
    // blocking > high > normal > low, then oldest first: the thing someone is
    // stuck on should surface above chatter that merely arrived later.
    const sql = `SELECT * FROM inbox ${clause}
      ORDER BY CASE priority WHEN 'blocking' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
               ts ASC
      ${limitInSql ? `LIMIT ${String(Math.floor(query.limit as number))}` : ""}`;

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    let items = rows.map((r) => ({
      id: r["id"] as string,
      room: r["room"] as string,
      from: r["sender"] as string,
      ts: r["ts"] as string,
      kind: r["kind"] as string,
      needs: r["needs"] as string,
      priority: r["priority"] as string,
      thread: r["thread"] as string,
      tags: decodeTags(r["tags"]),
      path: r["path"] as string,
      body: r["body"] as string,
      processedAt: (r["processed_at"] as string | null) ?? null,
    }));

    if (query.tag !== undefined) {
      const tag = query.tag;
      items = items.filter((item) => item.tags.includes(tag));
      if (query.limit !== undefined) items = items.slice(0, Math.floor(query.limit));
    }
    return items;
  }

  /**
   * Mark items processed.
   *
   * `needs: human` items are deliberately NOT drainable here. They remain
   * pending until an answer is recorded through the cooperative human-relay
   * path (ADR 0012).
   */
  markProcessed(ids: readonly string[]): number {
    if (ids.length === 0) return 0;
    const stmt = this.db.prepare(
      "UPDATE inbox SET processed_at = ? WHERE id = ? AND processed_at IS NULL AND needs != 'human'",
    );
    const now = new Date().toISOString();
    let changed = 0;
    for (const id of ids) changed += stmt.run(now, id).changes as number;
    return changed;
  }

  /** Clear a `needs: human` item once a human-relayed answer has been recorded. */
  resolveHumanItem(id: string): boolean {
    const result = this.db
      .prepare("UPDATE inbox SET processed_at = ? WHERE id = ? AND processed_at IS NULL")
      .run(new Date().toISOString(), id);
    return (result.changes as number) > 0;
  }

  pendingCount(room?: string): number {
    const row = (
      room === undefined
        ? this.db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE processed_at IS NULL").get()
        : this.db
            .prepare("SELECT COUNT(*) AS n FROM inbox WHERE processed_at IS NULL AND room = ?")
            .get(room)
    ) as { n: number };
    return row.n;
  }

  hasPendingHumanDecision(): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM inbox WHERE processed_at IS NULL AND needs = 'human' LIMIT 1")
      .get() as unknown;
    return row !== undefined;
  }

  /** Timestamp of the newest message seen, for the cadence state machine. */
  lastActivityAt(): number | null {
    const row = this.db.prepare("SELECT MAX(ts) AS ts FROM inbox").get() as { ts: string | null };
    if (row.ts === null) return null;
    const parsed = Date.parse(row.ts);
    return Number.isNaN(parsed) ? null : parsed;
  }

  // --------------------------------------------------------------------- meta

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }
}

/**
 * Decode the stored tag array defensively.
 *
 * A row written by an older build has the `'[]'` default, and the column is
 * populated from a header parsed off another machine. Neither is a reason to
 * make the whole inbox unreadable, so anything unexpected reads as no tags.
 */
function decodeTags(raw: unknown): string[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((tag) => typeof tag === "string") : [];
  } catch {
    return [];
  }
}
