import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { createReviewTask, ulid } from "@komnet/protocol";

import { defaultIdentity, emptyConfig, loadConfig, saveConfig } from "../src/config.ts";
import { Layout } from "../src/layout.ts";
import {
  ReviewRepositoryResolver,
  canonicalRepositoryFromRemote,
} from "../src/review/repository.ts";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=review-test",
      "-c",
      "user.email=review@test.invalid",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
  return stdout.trim();
}

describe("local repository review resolver", () => {
  it("prepares exact isolated revisions, enforces limits, and releases cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "komnet-review-repo-"));
    const product = join(root, "product");
    const layout = new Layout(join(root, "home"));
    try {
      await exec("git", ["init", "--quiet", "--initial-branch=main", product]);
      await writeFile(join(product, "service.ts"), "export const version = 1;\n", "utf8");
      await git(product, "add", "service.ts");
      await git(product, "commit", "--quiet", "-m", "base");
      const baseRev = await git(product, "rev-parse", "HEAD");
      await writeFile(join(product, "service.ts"), "export const version = 2;\n", "utf8");
      await git(product, "commit", "--quiet", "-am", "head");
      const headRev = await git(product, "rev-parse", "HEAD");
      await writeFile(join(product, "local-only.txt"), "do not touch\n", "utf8");

      const config = emptyConfig(defaultIdentity({ id: "bob-codex" }));
      config.repositories["github.com/acme/payments"] = { path: product };
      await saveConfig(layout.configPath, config);
      const loaded = await loadConfig(layout.configPath);
      assert.ok(loaded);
      const resolver = new ReviewRepositoryResolver(layout, loaded);
      const review = createReviewTask({
        id: ulid(),
        requester: "alice-codex",
        reviewer: "bob-codex",
        repo: "github.com/acme/payments",
        baseRev,
        headRev,
        scope: ["service.ts"],
      });

      const prepared = await resolver.prepare(review, "bob-codex");
      assert.equal(prepared.relation, "base-is-ancestor");
      assert.equal(prepared.reused, false);
      assert.equal(await git(prepared.checkoutPath, "rev-parse", "HEAD"), headRev);
      assert.equal(
        await readFile(join(prepared.checkoutPath, "service.ts"), "utf8"),
        "export const version = 2;\n",
      );
      assert.match(await git(product, "status", "--porcelain"), /local-only\.txt/);

      const reused = await resolver.prepare(review, "bob-codex");
      assert.equal(reused.reused, true);
      assert.equal(reused.checkoutPath, prepared.checkoutPath);
      await assert.rejects(() => resolver.prepare(review, "alice-codex"), /only declared reviewer/);

      const second = createReviewTask({
        ...review,
        id: ulid(),
      });
      await assert.rejects(() => resolver.prepare(second, "bob-codex"), /worktree limit 1/);
      await assert.rejects(
        () => resolver.release(review.id, "alice-codex"),
        /only declared reviewer/,
      );
      const localNote = join(prepared.checkoutPath, "review-notes.txt");
      await writeFile(localNote, "preserve this artifact\n", "utf8");
      await assert.rejects(() => resolver.release(review.id, "bob-codex"), /local changes/);
      await rm(localNote);
      assert.equal((await resolver.release(review.id, "bob-codex")).released, true);
      await assert.rejects(() => access(prepared.checkoutPath));

      const next = await resolver.prepare(second, "bob-codex");
      assert.equal(next.reused, false);
      await resolver.release(second.id, "bob-codex");

      const unmanaged = createReviewTask({ ...review, id: ulid() });
      const unmanagedFile = join(layout.reviewDir(unmanaged.id), "keep.txt");
      await mkdir(layout.reviewDir(unmanaged.id), { recursive: true });
      await writeFile(unmanagedFile, "not resolver-owned\n", "utf8");
      await assert.rejects(
        () => resolver.prepare(unmanaged, "bob-codex"),
        /unmanaged review directory/,
      );
      await assert.rejects(
        () => resolver.release(unmanaged.id, "bob-codex"),
        /unmanaged review directory/,
      );
      assert.equal(await readFile(unmanagedFile, "utf8"), "not resolver-owned\n");
      await rm(layout.reviewDir(unmanaged.id), { recursive: true });

      const unavailable = createReviewTask({
        ...review,
        id: ulid(),
        headRev: "f".repeat(40),
      });
      await assert.rejects(
        () => resolver.prepare(unavailable, "bob-codex"),
        /fetching is disabled/,
      );
    } finally {
      // Retried like every other fixture teardown: git may still be writing
      // into the repository when this fires, and a plain recursive remove
      // then fails with ENOTEMPTY on macOS.
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("normalises conventional remotes and rejects a mapped lookalike", async () => {
    assert.equal(
      canonicalRepositoryFromRemote("git@github.com:acme/payments.git"),
      "github.com/acme/payments",
    );
    assert.equal(
      canonicalRepositoryFromRemote("https://github.com/acme/payments.git"),
      "github.com/acme/payments",
    );
    assert.equal(canonicalRepositoryFromRemote("/srv/git/payments.git"), null);

    const root = await mkdtemp(join(tmpdir(), "komnet-review-remote-"));
    const product = join(root, "product");
    try {
      await exec("git", ["init", "--quiet", "--initial-branch=main", product]);
      await git(product, "remote", "add", "origin", "https://github.com/lookalike/payments.git");
      const config = emptyConfig(defaultIdentity({ id: "bob-codex" }));
      const resolver = new ReviewRepositoryResolver(new Layout(join(root, "home")), config);
      await assert.rejects(
        () =>
          resolver.inspectMapping("github.com/acme/payments", {
            path: product,
            fetchRemote: "origin",
          }),
        /mapping mismatch/,
      );
    } finally {
      // Retried like every other fixture teardown: git may still be writing
      // into the repository when this fires, and a plain recursive remove
      // then fails with ENOTEMPTY on macOS.
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("fetches missing objects only when a local remote is explicitly authorised", async () => {
    const root = await mkdtemp(join(tmpdir(), "komnet-review-fetch-"));
    const remote = join(root, "product.git");
    const seed = join(root, "seed");
    const product = join(root, "product");
    const layout = new Layout(join(root, "home"));
    try {
      await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
      await exec("git", ["init", "--quiet", "--initial-branch=main", seed]);
      await writeFile(join(seed, "service.ts"), "export const version = 1;\n", "utf8");
      await git(seed, "add", "service.ts");
      await git(seed, "commit", "--quiet", "-m", "base");
      const baseRev = await git(seed, "rev-parse", "HEAD");
      await git(seed, "remote", "add", "origin", remote);
      await git(seed, "push", "--quiet", "-u", "origin", "main");
      await exec("git", ["clone", "--quiet", remote, product]);

      await writeFile(join(seed, "service.ts"), "export const version = 2;\n", "utf8");
      await git(seed, "commit", "--quiet", "-am", "head");
      const headRev = await git(seed, "rev-parse", "HEAD");
      await git(seed, "push", "--quiet", "origin", "main");
      assert.equal(await git(product, "rev-parse", "HEAD"), baseRev);
      await assert.rejects(() => git(product, "cat-file", "-e", `${headRev}^{commit}`));

      const config = emptyConfig(defaultIdentity({ id: "bob-codex" }));
      config.repositories["github.com/acme/payments"] = {
        path: product,
        fetchRemote: "origin",
      };
      const resolver = new ReviewRepositoryResolver(layout, config);
      const review = createReviewTask({
        id: ulid(),
        requester: "alice-codex",
        reviewer: "bob-codex",
        repo: "github.com/acme/payments",
        baseRev,
        headRev,
      });

      const prepared = await resolver.prepare(review, "bob-codex");
      assert.equal(await git(prepared.checkoutPath, "rev-parse", "HEAD"), headRev);
      assert.equal(await git(product, "rev-parse", "HEAD"), baseRev);
      await resolver.release(review.id, "bob-codex");
    } finally {
      // Retried like every other fixture teardown: git may still be writing
      // into the repository when this fires, and a plain recursive remove
      // then fails with ENOTEMPTY on macOS.
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
