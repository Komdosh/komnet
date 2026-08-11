import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Message } from "@kom-net/protocol";

/**
 * Local index over the repository.
 *
 * **This is a cache.** Every row here is derivable from git, and the file may
 * be deleted at any time — `Network.rebuildState` walks the refs and refills
 * it. Nothing may exist only in sqlite, because the repository is the source of
 * truth (docs/design/02-architecture.md §3).
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
  path: string;
  body: string;
  processedAt: string | null;
}

export interface InboxQuery {
  room?: string;
  needs?: string;
  includeProcessed?: boolean;
  limit?: number;
}

/**
 * Bump on any schema change. Because this file is a cache and never a source of
 * truth, a mismatch is resolved by discarding and rebuilding from git rather
 * than by writing migrations.
 */
const SCHEMA_VERSION = "2";

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
        `INSERT INTO inbox (id, room, sender, ts, kind, needs, priority, thread, path, body, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
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
    // blocking > high > normal > low, then oldest first: the thing someone is
    // stuck on should surface above chatter that merely arrived later.
    const sql = `SELECT * FROM inbox ${clause}
      ORDER BY CASE priority WHEN 'blocking' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
               ts ASC
      ${query.limit === undefined ? "" : `LIMIT ${String(Math.floor(query.limit))}`}`;

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r["id"] as string,
      room: r["room"] as string,
      from: r["sender"] as string,
      ts: r["ts"] as string,
      kind: r["kind"] as string,
      needs: r["needs"] as string,
      priority: r["priority"] as string,
      thread: r["thread"] as string,
      path: r["path"] as string,
      body: r["body"] as string,
      processedAt: (r["processed_at"] as string | null) ?? null,
    }));
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
