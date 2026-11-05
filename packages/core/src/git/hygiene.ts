/**
 * Debris an interrupted git leaves in a repository, and how to tell it from a
 * git that is still running.
 *
 * Git serialises writers with `*.lock` files it creates exclusively and
 * removes on exit — including on SIGTERM and SIGINT, through its own signal
 * handlers. A process killed with SIGKILL, or a machine that loses power,
 * skips that cleanup, and the lock then refuses every later write with
 * `Unable to create '…/index.lock': File exists` until someone removes it.
 * On 2026-11-05 such files were days old and had wedged a daemon since.
 */

import type { Dirent } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * How old a git lock file must be before it is treated as orphaned.
 *
 * Every git komnet starts is asked to stop at its timeout — two minutes at most
 * (`NETWORK_TIMEOUT_MS`) — and killed a few seconds later, so no git komnet
 * started can still hold a lock this old. Git itself holds these locks for
 * milliseconds to seconds. The one legitimate long holder is an interactive
 * `git commit` waiting on an editor, which nothing runs inside komnet's private
 * transport directory.
 */
export const STALE_GIT_LOCK_MS = 10 * 60_000;

export interface GitLockFile {
  path: string;
  ageMs: number;
  bytes: number;
  stale: boolean;
}

/** The one shape every git lock refusal takes, whichever lock it names. */
const LOCK_EXISTS = /Unable to create '([^']+\.lock)': File exists/;

/** The lock file a failed git command was refused by, if that is why it failed. */
export function lockPathFromGitError(stderr: string): string | null {
  return LOCK_EXISTS.exec(stderr)?.[1] ?? null;
}

async function lockFile(path: string, now: number, staleMs: number): Promise<GitLockFile | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    const ageMs = Math.max(0, now - info.mtimeMs);
    return { path, ageMs, bytes: info.size, stale: ageMs >= staleMs };
  } catch {
    return null;
  }
}

/**
 * Remove a git lock file if it is old enough that no running git can own it.
 *
 * Returns what was removed, or null when the file is fresh or already gone.
 * The caller must also know that none of ITS OWN git processes is running in
 * this repository: age alone cannot rule out a git it started a moment ago.
 */
export async function removeStaleGitLock(
  path: string,
  staleMs = STALE_GIT_LOCK_MS,
  now = Date.now(),
): Promise<GitLockFile | null> {
  const lock = await lockFile(path, now, staleMs);
  if (lock === null || !lock.stale) return null;
  try {
    await unlink(path);
    return lock;
  } catch {
    // Removed by someone else in the meantime: the outcome we wanted.
    return null;
  }
}

async function locksIn(
  dir: string,
  now: number,
  staleMs: number,
  recurse: boolean,
): Promise<GitLockFile[]> {
  const found: GitLockFile[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recurse) found.push(...(await locksIn(path, now, staleMs, true)));
    } else if (entry.name.endsWith(".lock")) {
      const lock = await lockFile(path, now, staleMs);
      if (lock !== null) found.push(lock);
    }
  }
  return found;
}

/**
 * Every git lock file in a bare repository and the worktrees attached to it.
 *
 * Covers where git actually puts them: the repository root (`HEAD.lock`,
 * `index.lock`, `packed-refs.lock`, `config.lock`, `shallow.lock`), each
 * worktree's admin directory under `worktrees/`, and the ref tree under
 * `refs/` (`refs/heads/main.lock`, `refs/remotes/origin/…lock`).
 */
export async function findGitLocks(
  gitDir: string,
  options: { now?: number; staleMs?: number } = {},
): Promise<GitLockFile[]> {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? STALE_GIT_LOCK_MS;
  const found = await locksIn(gitDir, now, staleMs, false);
  let worktrees: string[] = [];
  try {
    worktrees = await readdir(join(gitDir, "worktrees"));
  } catch {
    // No linked worktrees.
  }
  for (const name of worktrees) {
    found.push(...(await locksIn(join(gitDir, "worktrees", name), now, staleMs, false)));
  }
  found.push(...(await locksIn(join(gitDir, "refs"), now, staleMs, true)));
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/** A duration a person can read at a glance: `45s`, `12m`, `3h`, `4d`. */
export function humanAge(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${String(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${String(minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)}h`;
  return `${String(Math.round(hours / 24))}d`;
}
