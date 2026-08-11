import { mkdir, open, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
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
  /** A lock older than this is considered abandoned and may be stolen. */
  staleMs?: number;
  pollMs?: number;
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
    const staleMs = options.staleMs ?? 5 * 60_000;
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
      return JSON.parse(await readFile(path, "utf8")) as LockRecord;
    } catch {
      return null;
    }
  }

  private static async isStale(path: string, staleMs: number): Promise<boolean> {
    const record = await FileLock.read(path);
    // Unparseable lock file: treat as debris rather than blocking forever.
    if (record === null) return true;

    if (Date.now() - Date.parse(record.acquiredAt) > staleMs) return true;

    // A live pid check is only meaningful on the machine that took the lock.
    if (record.host === hostname()) {
      try {
        process.kill(record.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      }
    }
    return false;
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
