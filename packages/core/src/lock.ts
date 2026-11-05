import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { hostname, uptime } from "node:os";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

interface LockRecord {
  pid: number;
  host: string;
  acquiredAt: string;
}

export interface LockOptions {
  /** Give up waiting after this long. */
  timeoutMs?: number;
  /**
   * A lock taken on ANOTHER machine longer ago than this is considered
   * abandoned. On this machine the holder's liveness decides instead.
   */
  staleMs?: number;
  pollMs?: number;
}

/** Who holds a lock, as `komnet doctor` reports it. */
export interface LockHolder {
  pid: number;
  host: string;
  acquiredAt: string;
  ageMs: number;
  /** Whether the holder is still running; null when it is on another machine. */
  alive: boolean | null;
  stale: boolean;
}

const DEFAULT_STALE_MS = 5 * 60_000;

/**
 * How long an empty or unreadable lock file is presumed to be mid-creation.
 *
 * `wx` creates the file empty and the record is written a moment later. A
 * reader in between used to call it debris and delete it, so two processes
 * both believed they held the lock.
 */
const UNWRITTEN_GRACE_MS = 10_000;

/** When this machine last booted; a holder recorded before then is gone. */
function bootTime(): number {
  return Date.now() - uptime() * 1000;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it is just not ours to signal.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Exclusive lock over one network's object store.
 *
 * Direct mode (ADR 0005) lets the CLI run git itself when no daemon is up, and
 * two concurrent `git` processes in one worktree corrupt index state. This is
 * what keeps a shell loop of `komnet send` from destroying its own checkout.
 *
 * Created with `wx`, so acquisition is a single atomic filesystem operation
 * rather than a check-then-create race.
 */
export class FileLock {
  readonly path: string;
  private released = false;

  private constructor(path: string) {
    this.path = path;
  }

  static async acquire(path: string, options: LockOptions = {}): Promise<FileLock> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    const pollMs = options.pollMs ?? 100;
    const deadline = Date.now() + timeoutMs;

    await mkdir(dirname(path), { recursive: true });

    for (;;) {
      try {
        const handle = await open(path, "wx");
        const record: LockRecord = {
          pid: process.pid,
          host: hostname(),
          acquiredAt: new Date().toISOString(),
        };
        await handle.writeFile(JSON.stringify(record), "utf8");
        await handle.close();
        return new FileLock(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      if (await FileLock.isStale(path, staleMs)) {
        // The holder died without releasing. Removing the file rather than
        // taking it over means the next `wx` still decides the winner.
        await rm(path, { force: true });
        continue;
      }

      if (Date.now() >= deadline) {
        const holder = await FileLock.read(path);
        const who = holder === null ? "unknown" : `pid ${String(holder.pid)} on ${holder.host}`;
        throw new Error(
          `timed out after ${String(timeoutMs)}ms waiting for ${path} (held by ${who}). ` +
            `If that process is gone, remove the file.`,
        );
      }
      await sleep(pollMs);
    }
  }

  private static async read(path: string): Promise<LockRecord | null> {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
      if (
        typeof value.pid !== "number" ||
        typeof value.host !== "string" ||
        typeof value.acquiredAt !== "string" ||
        !Number.isFinite(Date.parse(value.acquiredAt))
      ) {
        return null;
      }
      return value as LockRecord;
    } catch {
      return null;
    }
  }

  /**
   * Whether the holder is gone.
   *
   * On this machine that is a fact to check, not an age to guess: the lock is
   * stale exactly when its process is dead, or was recorded before the last
   * boot (so its pid may since belong to something else). Age alone used to
   * decide after five minutes, so a seal that held the lock longer had it
   * stolen while still running, and two writers ran git in one worktree at once
   * — `cannot lock ref 'HEAD': is at … but expected …` in the daemon log.
   *
   * Another machine's pid cannot be checked, so there age is all there is.
   */
  private static async isStale(path: string, staleMs: number): Promise<boolean> {
    const record = await FileLock.read(path);
    if (record === null) {
      try {
        return Date.now() - (await stat(path)).mtimeMs > UNWRITTEN_GRACE_MS;
      } catch {
        return true; // Released meanwhile; the next `wx` decides.
      }
    }
    const acquired = Date.parse(record.acquiredAt);
    if (record.host !== hostname()) return Date.now() - acquired > staleMs;
    // A minute of slack keeps clock adjustments around boot from misjudging it.
    if (acquired < bootTime() - 60_000) return true;
    return !isAlive(record.pid);
  }

  /** Who holds the lock at `path`, or null when nobody does. Never modifies it. */
  static async inspect(path: string, staleMs = DEFAULT_STALE_MS): Promise<LockHolder | null> {
    const record = await FileLock.read(path);
    if (record === null) {
      try {
        await stat(path);
      } catch {
        return null;
      }
      return {
        pid: 0,
        host: "unknown",
        acquiredAt: "unknown",
        ageMs: 0,
        alive: null,
        stale: await FileLock.isStale(path, staleMs),
      };
    }
    return {
      ...record,
      ageMs: Math.max(0, Date.now() - Date.parse(record.acquiredAt)),
      alive: record.host === hostname() ? isAlive(record.pid) : null,
      stale: await FileLock.isStale(path, staleMs),
    };
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await rm(this.path, { force: true });
  }

  /** Run `fn` under the lock, releasing even if it throws. */
  static async withLock<T>(path: string, fn: () => Promise<T>, options?: LockOptions): Promise<T> {
    const lock = await FileLock.acquire(path, options);
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }
}
