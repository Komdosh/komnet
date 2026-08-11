import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";

import { isTerminalReviewTaskState, type ReviewTask } from "@komnet/protocol";

import { type KomnetConfig, type LocalRepositoryConfig } from "../config.ts";
import { GitError } from "../errors.ts";
import { GitRunner } from "../git/runner.ts";
import { Layout } from "../layout.ts";
import { FileLock } from "../lock.ts";

interface PreparedReviewMetadata {
  v: 1;
  state: "preparing" | "ready";
  reviewId: string;
  reviewer: string;
  repo: string;
  sourcePath: string;
  checkoutPath: string;
  baseRev: string;
  headRev: string;
  relation: ReviewRevisionRelation;
  createdAt: string;
}

export type ReviewRevisionRelation = "base-is-ancestor" | "diverged";

export interface PreparedReviewRepository {
  reviewId: string;
  repo: string;
  sourcePath: string;
  checkoutPath: string;
  baseRev: string;
  headRev: string;
  scope: string[];
  relation: ReviewRevisionRelation;
  reused: boolean;
  /** Structured invocation data; consumers must still pass args without a shell. */
  diff: { cwd: string; args: string[] };
}

export interface ReleasedReviewRepository {
  reviewId: string;
  released: boolean;
  checkoutPath: string | null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripGitSuffix(path: string): string {
  return path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
}

/** Convert conventional HTTPS/SSH/scp git remotes to the shared canonical id. */
export function canonicalRepositoryFromRemote(remote: string): string | null {
  const value = remote.trim();
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
  if (scp !== null && !value.includes("://")) {
    const path = stripGitSuffix(scp[2] as string);
    return path.includes("/") ? `${(scp[1] as string).toLowerCase()}/${path}` : null;
  }

  try {
    const url = new URL(value);
    if (!["git:", "http:", "https:", "ssh:"].includes(url.protocol)) return null;
    const path = stripGitSuffix(url.pathname);
    return url.hostname !== "" && path.includes("/")
      ? `${url.hostname.toLowerCase()}/${path}`
      : null;
  } catch {
    // Local paths are valid local mappings but carry no portable identity.
    return null;
  }
}

async function readMetadata(path: string): Promise<PreparedReviewMetadata | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as PreparedReviewMetadata;
    if (parsed.v !== 1 || (parsed.state !== "preparing" && parsed.state !== "ready")) {
      throw new Error("unsupported metadata format");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${path}: unreadable review metadata: ${describe(error)}`);
  }
}

async function writeMetadata(path: string, metadata: PreparedReviewMetadata): Promise<void> {
  await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function localPathKind(path: string): Promise<"directory" | "other" | "symlink" | null> {
  try {
    const value = await lstat(path);
    if (value.isSymbolicLink()) return "symlink";
    return value.isDirectory() ? "directory" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function hasCommit(runner: GitRunner, cwd: string, revision: string): Promise<boolean> {
  try {
    await runner.run(["cat-file", "-e", `${revision}^{commit}`], { cwd });
    return true;
  } catch (error) {
    if (error instanceof GitError) return false;
    throw error;
  }
}

async function revisionRelation(
  runner: GitRunner,
  cwd: string,
  baseRev: string,
  headRev: string,
): Promise<ReviewRevisionRelation> {
  try {
    await runner.run(["merge-base", "--is-ancestor", baseRev, headRev], { cwd });
    return "base-is-ancestor";
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) return "diverged";
    throw error;
  }
}

function samePreparedTask(metadata: PreparedReviewMetadata, review: ReviewTask): boolean {
  return (
    metadata.reviewId === review.id &&
    metadata.reviewer === review.reviewer &&
    metadata.repo === review.repo &&
    metadata.baseRev === review.baseRev &&
    metadata.headRev === review.headRev
  );
}

function resultFrom(
  review: ReviewTask,
  metadata: PreparedReviewMetadata,
  reused: boolean,
): PreparedReviewRepository {
  return {
    reviewId: review.id,
    repo: review.repo,
    sourcePath: metadata.sourcePath,
    checkoutPath: metadata.checkoutPath,
    baseRev: review.baseRev,
    headRev: review.headRev,
    scope: [...review.scope],
    relation: metadata.relation,
    reused,
    diff: {
      cwd: metadata.checkoutPath,
      args: [
        "diff",
        "--find-renames",
        review.baseRev,
        review.headRev,
        ...(review.scope.length === 0 ? [] : ["--", ...review.scope]),
      ],
    },
  };
}

export class ReviewRepositoryResolver {
  private readonly layout: Layout;
  private readonly config: Pick<KomnetConfig, "repositories" | "review">;
  private readonly runner: GitRunner;

  constructor(
    layout: Layout,
    config: Pick<KomnetConfig, "repositories" | "review">,
    runner = new GitRunner(),
  ) {
    this.layout = layout;
    this.config = config;
    this.runner = runner;
  }

  async inspectMapping(
    repositoryId: string,
    mapping: LocalRepositoryConfig,
  ): Promise<{ sourcePath: string; remoteUrl: string | null }> {
    const sourcePath = await realpath(mapping.path);
    const top = (
      await this.runner.run(["rev-parse", "--path-format=absolute", "--show-toplevel"], {
        cwd: sourcePath,
      })
    ).stdout.trim();
    const realTop = await realpath(top);
    if (realTop !== sourcePath) {
      throw new Error(
        `repository mapping ${repositoryId} must point at the git worktree root; got ${sourcePath}, root is ${realTop}`,
      );
    }

    const remoteName = mapping.fetchRemote ?? "origin";
    let remoteUrl: string | null = null;
    try {
      remoteUrl = (
        await this.runner.run(["remote", "get-url", remoteName], { cwd: sourcePath })
      ).stdout.trim();
    } catch (error) {
      if (mapping.fetchRemote !== undefined) {
        throw new Error(
          `repository ${repositoryId} authorises fetch remote '${remoteName}', but it is unavailable: ${describe(error)}`,
        );
      }
    }

    if (remoteUrl !== null) {
      const remoteId = canonicalRepositoryFromRemote(remoteUrl);
      if (remoteId !== null && remoteId.toLowerCase() !== repositoryId.toLowerCase()) {
        throw new Error(
          `repository mapping mismatch: ${repositoryId} points at remote ${remoteId}`,
        );
      }
    }
    return { sourcePath, remoteUrl };
  }

  async prepare(review: ReviewTask, actorId: string): Promise<PreparedReviewRepository> {
    if (review.reviewer !== actorId) {
      throw new Error(`only declared reviewer ${review.reviewer} may prepare this repository`);
    }
    if (isTerminalReviewTaskState(review.state)) {
      throw new Error(`review ${review.id} is already terminal (${review.state})`);
    }

    return await FileLock.withLock(this.layout.reviewsLockPath, async () => {
      const mapping = this.config.repositories[review.repo];
      if (mapping === undefined) {
        throw new Error(
          `no local mapping for ${review.repo}; configure it with: komnet repo map ${review.repo} <path>`,
        );
      }
      const { sourcePath } = await this.inspectMapping(review.repo, mapping);
      const reviewDir = this.layout.reviewDir(review.id);
      const metadataPath = this.layout.reviewMetadataPath(review.id);
      const checkoutPath = this.layout.reviewWorktree(review.id);
      const pathKind = await localPathKind(reviewDir);
      if (pathKind === "symlink" || pathKind === "other") {
        throw new Error(`refusing unsafe review directory ${reviewDir}`);
      }
      const existing = await readMetadata(metadataPath);
      if (pathKind === "directory" && existing === null) {
        throw new Error(
          `unmanaged review directory already exists at ${reviewDir}; inspect it before retrying`,
        );
      }
      if (existing !== null && existing.state === "ready") {
        this.assertMetadataPaths(review.id, existing);
        if (!samePreparedTask(existing, review)) {
          throw new Error(`prepared worktree ${review.id} does not match the immutable task`);
        }
        const head = (
          await this.runner.run(["rev-parse", "HEAD"], { cwd: checkoutPath })
        ).stdout.trim();
        if (head !== review.headRev) {
          throw new Error(
            `prepared worktree ${checkoutPath} moved from ${review.headRev} to ${head}; refusing to overwrite it`,
          );
        }
        return resultFrom(review, existing, true);
      }

      if (existing !== null) {
        this.assertMetadataPaths(review.id, existing);
        await this.removeGeneratedWorktree(existing, true);
      }
      const preparedCount = await this.preparedCount();
      if (preparedCount >= this.config.review.maxPreparedWorktrees) {
        throw new Error(
          `local review worktree limit ${String(this.config.review.maxPreparedWorktrees)} reached; release one with: komnet review release <review-id>`,
        );
      }

      let haveBase = await hasCommit(this.runner, sourcePath, review.baseRev);
      let haveHead = await hasCommit(this.runner, sourcePath, review.headRev);
      if ((!haveBase || !haveHead) && mapping.fetchRemote !== undefined) {
        await this.runner.run(["fetch", "--no-tags", mapping.fetchRemote], { cwd: sourcePath });
        haveBase = await hasCommit(this.runner, sourcePath, review.baseRev);
        haveHead = await hasCommit(this.runner, sourcePath, review.headRev);
      }
      const missing = [
        ...(haveBase ? [] : [`base ${review.baseRev}`]),
        ...(haveHead ? [] : [`head ${review.headRev}`]),
      ];
      if (missing.length > 0) {
        const hint =
          mapping.fetchRemote === undefined
            ? "fetching is disabled; remap with --fetch-remote <name> to authorise it"
            : `fetch remote '${mapping.fetchRemote}' did not provide them`;
        throw new Error(`repository ${review.repo} is missing ${missing.join(" and ")}; ${hint}`);
      }

      const relation = await revisionRelation(
        this.runner,
        sourcePath,
        review.baseRev,
        review.headRev,
      );
      const metadata: PreparedReviewMetadata = {
        v: 1,
        state: "preparing",
        reviewId: review.id,
        reviewer: review.reviewer,
        repo: review.repo,
        sourcePath,
        checkoutPath,
        baseRev: review.baseRev,
        headRev: review.headRev,
        relation,
        createdAt: new Date().toISOString(),
      };

      await mkdir(reviewDir);
      await writeMetadata(metadataPath, metadata);
      try {
        await this.runner.run(
          [
            "-c",
            "core.hooksPath=/dev/null",
            "worktree",
            "add",
            "--detach",
            checkoutPath,
            review.headRev,
          ],
          { cwd: sourcePath },
        );
        metadata.state = "ready";
        await writeMetadata(metadataPath, metadata);
        return resultFrom(review, metadata, false);
      } catch (error) {
        await this.removeGeneratedWorktree(metadata, true).catch(() => undefined);
        throw error;
      }
    });
  }

  async release(reviewId: string, actorId: string): Promise<ReleasedReviewRepository> {
    return await FileLock.withLock(this.layout.reviewsLockPath, async () => {
      const reviewDir = this.layout.reviewDir(reviewId);
      const pathKind = await localPathKind(reviewDir);
      if (pathKind === null) return { reviewId, released: false, checkoutPath: null };
      if (pathKind !== "directory") {
        throw new Error(`refusing unsafe review directory ${reviewDir}`);
      }
      const metadata = await readMetadata(this.layout.reviewMetadataPath(reviewId));
      if (metadata === null) {
        throw new Error(
          `unmanaged review directory already exists at ${reviewDir}; inspect it before release`,
        );
      }
      this.assertMetadataPaths(reviewId, metadata);
      if (metadata.reviewer !== actorId) {
        throw new Error(`only declared reviewer ${metadata.reviewer} may release this worktree`);
      }
      await this.removeGeneratedWorktree(metadata, false);
      return { reviewId, released: true, checkoutPath: metadata.checkoutPath };
    });
  }

  private async preparedCount(): Promise<number> {
    try {
      return (await readdir(this.layout.reviewsDir, { withFileTypes: true })).filter((entry) =>
        entry.isDirectory(),
      ).length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  private assertMetadataPaths(reviewId: string, metadata: PreparedReviewMetadata): void {
    if (
      metadata.reviewId !== reviewId ||
      metadata.checkoutPath !== this.layout.reviewWorktree(reviewId)
    ) {
      throw new Error(`review ${reviewId} metadata does not describe its managed checkout`);
    }
  }

  private async removeGeneratedWorktree(
    metadata: PreparedReviewMetadata,
    force: boolean,
  ): Promise<void> {
    try {
      await this.runner.run(
        ["worktree", "remove", ...(force ? ["--force"] : []), metadata.checkoutPath],
        { cwd: metadata.sourcePath },
      );
    } catch (error) {
      if (force) {
        await rm(metadata.checkoutPath, { recursive: true, force: true });
        await this.runner.run(["worktree", "prune"], { cwd: metadata.sourcePath });
      } else {
        throw new Error(
          `cannot release ${metadata.checkoutPath}; it may contain local changes: ${describe(error)}`,
        );
      }
    }
    await rm(this.layout.reviewDir(metadata.reviewId), { recursive: true, force: true });
  }
}
