import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleepMs } from "node:timers/promises";

import { ROOM_REF_GLOB, roomIdFromRef, roomRef } from "@kom-net/protocol";

import { GitError, PushExhaustedError } from "../errors.ts";
import { GitRunner, NETWORK_TIMEOUT_MS, type GitRunOptions } from "./runner.ts";

export interface PushOptions {
  remote?: string;
  maxAttempts?: number;
  /** Base backoff in ms; actual delay is jittered (see `backoffDelay`). */
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** Injectable for tests, so retry behaviour can be asserted without waiting. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, error: GitError) => void;
}

export interface PushResult {
  attempts: number;
  rebased: boolean;
}

/**
 * Full-jitter exponential backoff.
 *
 * Jitter is required, not cosmetic: several agents rejected by the same push
 * would otherwise retry in lockstep and keep colliding, converting one
 * collision into a sustained retry storm (ADR 0004).
 */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  capMs: number,
  rand = Math.random,
): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(rand() * ceiling);
}

/** A ref name and the commit it points at. */
export interface RefEntry {
  ref: string;
  sha: string;
}

export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed" | "other";

export interface FileChange {
  status: FileChangeStatus;
  path: string;
}

function classify(code: string): FileChangeStatus {
  const c = code[0];
  if (c === "A") return "added";
  if (c === "M") return "modified";
  if (c === "D") return "deleted";
  if (c === "R") return "renamed";
  return "other";
}

/**
 * High-level git operations against one kom-net object store.
 *
 * `gitDir` is the bare clone; worktrees for `main` and each subscribed room
 * hang off it and share its objects (docs/design/03-git-topology.md §5).
 */
export class Repo {
  readonly gitDir: string;
  readonly runner: GitRunner;

  constructor(gitDir: string, runner: GitRunner = new GitRunner()) {
    this.gitDir = gitDir;
    this.runner = runner;
  }

  private opts(cwd: string, timeoutMs?: number): GitRunOptions {
    return timeoutMs === undefined ? { cwd } : { cwd, timeoutMs };
  }

  // ---------------------------------------------------------------- discovery

  /**
   * List remote refs matching `patterns` without transferring any objects.
   *
   * Under protocol v2 the patterns are applied server-side, so the response
   * carries only matching refs — this is the whole basis of cheap polling.
   */
  async lsRemote(remote: string, patterns: readonly string[] = []): Promise<RefEntry[]> {
    const out = await this.runner.lines(
      ["ls-remote", remote, ...patterns],
      this.opts(this.gitDir, NETWORK_TIMEOUT_MS),
    );
    const entries: RefEntry[] = [];
    for (const line of out) {
      const tab = line.indexOf("\t");
      if (tab === -1) continue;
      entries.push({ sha: line.slice(0, tab), ref: line.slice(tab + 1) });
    }
    return entries;
  }

  /**
   * One round trip yielding every room's head — the map the sync loop diffs
   * against its last known state (ADR 0008).
   */
  async lsRemoteRooms(remote: string): Promise<Map<string, string>> {
    const entries = await this.lsRemote(remote, [ROOM_REF_GLOB]);
    const rooms = new Map<string, string>();
    for (const { ref, sha } of entries) {
      const roomId = roomIdFromRef(ref);
      if (roomId !== null) rooms.set(roomId, sha);
    }
    return rooms;
  }

  async resolveRef(ref: string): Promise<string | null> {
    return await this.runner.tryText(
      ["rev-parse", "--verify", `${ref}^{commit}`],
      this.opts(this.gitDir),
    );
  }

  async refExists(ref: string): Promise<boolean> {
    return (await this.resolveRef(ref)) !== null;
  }

  // ------------------------------------------------------------------- setup

  static async cloneBare(
    remote: string,
    gitDir: string,
    runner: GitRunner = new GitRunner(),
  ): Promise<Repo> {
    const parent = dirname(gitDir);
    await mkdir(parent, { recursive: true });
    try {
      await runner.run(
        // blob:none defers file contents until something is actually read, so a
        // new joiner pays for the rooms they open rather than for all history.
        ["clone", "--bare", "--filter=blob:none", remote, gitDir],
        { cwd: parent, timeoutMs: NETWORK_TIMEOUT_MS },
      );
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      // Partial clone needs `uploadpack.allowFilter` on the server. Plain file
      // remotes and older hosts refuse it — fall back rather than fail, since a
      // full clone is merely larger, not broken.
      if (!/filter|allowFilter|unrecognized|not support/i.test(error.stderr)) throw error;
      await rm(gitDir, { recursive: true, force: true });
      await runner.run(["clone", "--bare", remote, gitDir], {
        cwd: parent,
        timeoutMs: NETWORK_TIMEOUT_MS,
      });
    }
    return new Repo(gitDir, runner);
  }

  static async initBare(gitDir: string, runner: GitRunner = new GitRunner()): Promise<Repo> {
    await mkdir(gitDir, { recursive: true });
    await runner.run(["init", "--bare", "--initial-branch=main"], { cwd: gitDir });
    return new Repo(gitDir, runner);
  }

  /**
   * Restrict the fetch refspec to `main` plus the subscribed rooms, so a fetch
   * never pulls rooms this machine does not care about.
   */
  async setFetchScope(remote: string, roomIds: readonly string[]): Promise<void> {
    const key = `remote.${remote}.fetch`;
    await this.runner.run(["config", "--unset-all", key], this.opts(this.gitDir)).catch(() => {
      // No existing refspec to clear — expected on a freshly initialised remote.
    });
    await this.runner.run(
      ["config", "--add", key, `+refs/heads/main:refs/remotes/${remote}/main`],
      this.opts(this.gitDir),
    );
    for (const roomId of roomIds) {
      const ref = roomRef(roomId);
      await this.runner.run(
        ["config", "--add", key, `+refs/heads/${ref}:refs/remotes/${remote}/${ref}`],
        this.opts(this.gitDir),
      );
    }
  }

  async addWorktree(
    path: string,
    branch: string,
    options?: { createFrom?: string },
  ): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const args =
      options?.createFrom === undefined
        ? ["worktree", "add", path, branch]
        : ["worktree", "add", "-b", branch, path, options.createFrom];
    await this.runner.run(args, this.opts(this.gitDir));
  }

  /**
   * Create a worktree on a brand-new orphan branch.
   *
   * Room branches are orphans so they carry only their own room — branching
   * from `main` would give every room a copy of the whole record and defeat
   * per-room fetch scoping (ADR 0003).
   */
  async addOrphanWorktree(path: string, branch: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    // `worktree add --orphan` (git 2.42+) is the only form that works in a
    // repository with no commits at all — which is exactly the state of a
    // freshly created private transport repo on first `komnet init`.
    await this.runner.run(
      ["worktree", "add", "--orphan", "-b", branch, path],
      this.opts(this.gitDir),
    );
  }

  /**
   * Advance a worktree to the fetched remote head.
   *
   * Fast-forward is the normal case. Divergence means this machine has local
   * commits that have not landed yet, so we rebase them on top — safe for the
   * same reason the push loop is (ADR 0004): our commits only add uniquely
   * named files.
   */
  async fastForward(
    worktree: string,
    remoteRef: string,
  ): Promise<"up-to-date" | "fast-forwarded" | "rebased"> {
    const before = await this.runner.text(["rev-parse", "HEAD"], this.opts(worktree));
    const target = await this.runner.tryText(
      ["rev-parse", "--verify", `${remoteRef}^{commit}`],
      this.opts(worktree),
    );
    if (target === null || target === before) return "up-to-date";

    try {
      await this.runner.run(["merge", "--ff-only", "--quiet", remoteRef], this.opts(worktree));
      return "fast-forwarded";
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      try {
        await this.runner.run(["rebase", remoteRef], this.opts(worktree));
        return "rebased";
      } catch (rebaseError) {
        await this.runner.run(["rebase", "--abort"], this.opts(worktree)).catch(() => undefined);
        throw rebaseError;
      }
    }
  }

  /** Parsed `git --version`, for capability checks in `komnet doctor`. */
  async version(): Promise<{ raw: string; major: number; minor: number }> {
    const raw = await this.runner.text(["--version"], this.opts(this.gitDir));
    const m = /(\d+)\.(\d+)/.exec(raw);
    return { raw, major: Number(m?.[1] ?? 0), minor: Number(m?.[2] ?? 0) };
  }

  async removeWorktree(path: string, force = false): Promise<void> {
    const args = force ? ["worktree", "remove", "--force", path] : ["worktree", "remove", path];
    await this.runner.run(args, this.opts(this.gitDir));
  }

  // ------------------------------------------------------------------ reading

  /** Added/modified/deleted paths between two commits, optionally scoped. */
  async diff(from: string, to: string, pathspec?: string): Promise<FileChange[]> {
    const args = ["diff", "--name-status", "-z", from, to];
    if (pathspec !== undefined) args.push("--", pathspec);
    const { stdout } = await this.runner.run(args, this.opts(this.gitDir));

    // -z output is NUL-separated: status, path, status, path...  Renames emit
    // an extra path field, so the cursor advances by three for those.
    const fields = stdout.split("\0").filter((f) => f.length > 0);
    const changes: FileChange[] = [];
    for (let i = 0; i < fields.length;) {
      const code = fields[i] as string;
      const status = classify(code);
      if (status === "renamed") {
        const dest = fields[i + 2];
        if (dest !== undefined) changes.push({ status, path: dest });
        i += 3;
      } else {
        const path = fields[i + 1];
        if (path !== undefined) changes.push({ status, path });
        i += 2;
      }
    }
    return changes;
  }

  /** Paths added to `ref` that did not exist at `from`. Null `from` means all. */
  async addedSince(from: string | null, to: string, pathspec?: string): Promise<string[]> {
    if (from === null) {
      const args = ["ls-tree", "-r", "--name-only", to];
      if (pathspec !== undefined) args.push(pathspec);
      return await this.runner.lines(args, this.opts(this.gitDir));
    }
    const changes = await this.diff(from, to, pathspec);
    return changes.filter((c) => c.status === "added").map((c) => c.path);
  }

  /**
   * Paths added to `pathspec` over a ref's history, each with the commit that
   * added it.
   *
   * This is how anything older than the live window is read (§ retention):
   * sealing removes messages from the tree, so `ls-tree` cannot see them, but
   * `git log --diff-filter=A` still can — and the commit is needed to resolve
   * the blob, since the path no longer exists at the ref's tip.
   */
  async logAddedPaths(
    ref: string,
    pathspec: string,
    options: { since?: string; maxCount?: number } = {},
  ): Promise<{ commit: string; path: string }[]> {
    const args = ["log", "--diff-filter=A", "--format=commit:%H", "--name-only", ref];
    if (options.since !== undefined) args.push(`--since=${options.since}`);
    if (options.maxCount !== undefined) args.push(`--max-count=${String(options.maxCount)}`);
    args.push("--", pathspec);

    const { stdout } = await this.runner.run(args, this.opts(this.gitDir));
    const results: { commit: string; path: string }[] = [];
    let commit = "";
    for (const line of stdout.split("\n")) {
      if (line.startsWith("commit:")) commit = line.slice("commit:".length);
      else if (line.length > 0 && commit !== "") results.push({ commit, path: line });
    }
    return results;
  }

  async readFile(ref: string, path: string): Promise<string | null> {
    return await this.runner.tryText(["show", `${ref}:${path}`], this.opts(this.gitDir));
  }

  // ------------------------------------------------------------------ writing

  /**
   * Stage one new file in a worktree and commit it.
   *
   * The message goes over stdin rather than argv so that nothing in it can hit
   * an argument-length limit or be misread as a flag.
   */
  async commitFile(
    worktree: string,
    relPath: string,
    contents: string,
    message: string,
  ): Promise<string> {
    const absolute = join(worktree, relPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
    await this.runner.run(["add", "--", relPath], this.opts(worktree));
    await this.runner.run(["commit", "--quiet", "-F", "-"], { cwd: worktree, input: message });
    return await this.runner.text(["rev-parse", "HEAD"], this.opts(worktree));
  }

  /**
   * Merge `ref` into the branch checked out at `worktree`.
   *
   * `allowUnrelatedHistories` is required for a room's FIRST seal: room
   * branches are created as orphans (ADR 0003), so they share no ancestry with
   * `main`. The merge cannot conflict — room subtrees are disjoint and message
   * filenames are globally unique — so a conflict here means an invariant has
   * been violated and is surfaced rather than resolved.
   */
  async merge(
    worktree: string,
    ref: string,
    options: { allowUnrelatedHistories?: boolean; message?: string } = {},
  ): Promise<void> {
    const args = ["merge", "--no-edit", "--quiet"];
    if (options.allowUnrelatedHistories === true) args.push("--allow-unrelated-histories");
    if (options.message !== undefined) args.push("-m", options.message);
    args.push(ref);
    try {
      await this.runner.run(args, this.opts(worktree));
    } catch (error) {
      await this.runner.run(["merge", "--abort"], this.opts(worktree)).catch(() => undefined);
      throw error;
    }
  }

  /** Remove paths from the index and worktree. Missing paths are ignored. */
  async removePaths(worktree: string, paths: readonly string[]): Promise<number> {
    if (paths.length === 0) return 0;
    let removed = 0;
    // Chunked: a seal can prune thousands of files, and every platform has an
    // argv length limit that a single invocation would eventually exceed.
    const CHUNK = 200;
    for (let i = 0; i < paths.length; i += CHUNK) {
      const batch = paths.slice(i, i + CHUNK);
      await this.runner.run(
        ["rm", "--quiet", "--ignore-unmatch", "--", ...batch],
        this.opts(worktree),
      );
      removed += batch.length;
    }
    return removed;
  }

  /** Whether the worktree has staged or unstaged changes. */
  async isDirty(worktree: string): Promise<boolean> {
    const out = await this.runner.text(["status", "--porcelain"], this.opts(worktree));
    return out.length > 0;
  }

  /** Stage everything and commit. Returns null when there was nothing to commit. */
  async commitAll(worktree: string, message: string): Promise<string | null> {
    await this.runner.run(["add", "-A"], this.opts(worktree));
    const staged = await this.runner.text(["diff", "--cached", "--name-only"], this.opts(worktree));
    if (staged.length === 0) return null;
    await this.runner.run(["commit", "--quiet", "-F", "-"], { cwd: worktree, input: message });
    return await this.runner.text(["rev-parse", "HEAD"], this.opts(worktree));
  }

  async fetch(remote: string, refspecs: readonly string[] = []): Promise<void> {
    await this.runner.run(
      ["fetch", "--quiet", "--prune", remote, ...refspecs],
      this.opts(this.gitDir, NETWORK_TIMEOUT_MS),
    );
  }

  /**
   * Push a branch, rebasing and retrying on rejection until it lands.
   *
   * Safe because of the append-only invariant (ADR 0004): our commits only add
   * uniquely-named files, so rebasing onto whatever arrived meanwhile cannot
   * conflict. Convergence is guaranteed — each retry starts from a strictly
   * newer head, and the only failure mode that could stall it is structurally
   * impossible.
   *
   * A conflict here therefore means the invariant has been violated. We abort
   * the rebase and surface it rather than leaving a half-rebased worktree.
   */
  async pushWithRetry(
    worktree: string,
    branch: string,
    options: PushOptions = {},
  ): Promise<PushResult> {
    const remote = options.remote ?? "origin";
    const maxAttempts = options.maxAttempts ?? 8;
    const baseMs = options.backoffBaseMs ?? 200;
    const capMs = options.backoffCapMs ?? 15_000;
    const sleep = options.sleep ?? ((ms: number) => sleepMs(ms));

    let rebased = false;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.runner.run(
          ["push", "--quiet", remote, `${branch}:${branch}`],
          this.opts(worktree, NETWORK_TIMEOUT_MS),
        );
        return { attempts: attempt, rebased };
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        // Auth needs a human. Retrying just burns time and may lock an account.
        if (error.isAuthFailure) throw error;
        if (!error.isNonFastForward && !error.isNetworkFailure) throw error;

        lastError = error;
        if (attempt === maxAttempts) break;
        options.onRetry?.(attempt, error);

        await sleep(backoffDelay(attempt, baseMs, capMs));

        if (error.isNonFastForward) {
          await this.fetch(remote, [`+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
          try {
            await this.runner.run(["rebase", `${remote}/${branch}`], this.opts(worktree));
            rebased = true;
          } catch (rebaseError) {
            await this.runner
              .run(["rebase", "--abort"], this.opts(worktree))
              .catch(() => undefined);
            throw rebaseError;
          }
        }
      }
    }

    throw new PushExhaustedError(maxAttempts, lastError);
  }

  /**
   * Push, resolving a rejection by MERGING rather than rebasing.
   *
   * `pushWithRetry` rebases, which is right for ordinary appends but wrong
   * during a seal: `git rebase` flattens merge commits by default, so it would
   * discard the room→main merge — and that merge is the only thing making the
   * sealed messages reachable from `main`. Dropping it would turn "pruning is
   * not data loss" into exactly that.
   */
  async pushPreservingMerges(
    worktree: string,
    branch: string,
    options: { remote?: string; maxAttempts?: number; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<PushResult> {
    const remote = options.remote ?? "origin";
    const maxAttempts = options.maxAttempts ?? 5;
    const sleep = options.sleep ?? ((ms: number) => sleepMs(ms));
    let merged = false;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.runner.run(
          ["push", "--quiet", remote, `${branch}:${branch}`],
          this.opts(worktree, NETWORK_TIMEOUT_MS),
        );
        return { attempts: attempt, rebased: merged };
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        if (error.isAuthFailure) throw error;
        if (!error.isNonFastForward && !error.isNetworkFailure) throw error;
        lastError = error;
        if (attempt === maxAttempts) break;

        await sleep(backoffDelay(attempt, 200, 5_000));
        if (error.isNonFastForward) {
          await this.fetch(remote, [`+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
          await this.merge(worktree, `refs/remotes/${remote}/${branch}`, {
            message: `komnet: reconcile ${branch}`,
          });
          merged = true;
        }
      }
    }
    throw new PushExhaustedError(maxAttempts, lastError);
  }

  /** Whether two refs share any ancestry — false means a merge needs `--allow-unrelated-histories`. */
  async hasCommonAncestor(a: string, b: string): Promise<boolean> {
    return (await this.runner.tryText(["merge-base", a, b], this.opts(this.gitDir))) !== null;
  }

  /** First push of a branch the remote has never seen. */
  async pushNewBranch(worktree: string, branch: string, remote = "origin"): Promise<void> {
    await this.runner.run(
      ["push", "--quiet", "--set-upstream", remote, `${branch}:${branch}`],
      this.opts(worktree, NETWORK_TIMEOUT_MS),
    );
  }
}
