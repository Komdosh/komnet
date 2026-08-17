/**
 * Which identity this machine commits and signs with.
 *
 * Grouped under "sealing" in `network.ts` purely by position: these four are
 * read by `publishAgentCard`, by `send` when the network signs, and by the sync
 * verification path — sealing never touches them.
 *
 * The verification itself is pure and lives in `../authenticity.ts`; this is the
 * part that has to ask git and the filesystem.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { exists } from "../fs.ts";
import { parseNetManifest, type AuthenticityMode, type NetManifest } from "../net.ts";
import type { GitRunner } from "../git/runner.ts";

/** What identity resolution needs from the network, and nothing more. */
export interface AuthenticityContext {
  readonly runner: GitRunner;
  /** The `main` checkout, which is where git config and the manifest are read from. */
  readonly recordWorktree: string;
}

/**
 * The git identity this machine commits with.
 *
 * Published on the agent card so `authenticity: git` has something to check
 * `from` against — otherwise the mode can only ever report "no binding".
 */
export async function gitIdentity(
  ctx: AuthenticityContext,
): Promise<{ name: string; email: string } | null> {
  // `git var GIT_AUTHOR_IDENT`, not `git config user.email`: the environment
  // (GIT_AUTHOR_EMAIL) overrides config when git actually authors a commit.
  // Recording the config value would publish one identity while committing
  // under another, and every legitimate message would fail verification.
  const ident = await ctx.runner.tryText(["var", "GIT_AUTHOR_IDENT"], {
    cwd: ctx.recordWorktree,
  });
  if (ident === null) return null;
  const match = /^(.*?)\s*<([^>]+)>/.exec(ident);
  if (match === null) return null;
  return { name: match[1] ?? "", email: match[2] ?? "" };
}

/** SSH key used for `authenticity: signed`, or null when none is configured. */
export async function signingKeyPath(ctx: AuthenticityContext): Promise<string | null> {
  const configured = await ctx.runner.tryText(["config", "user.signingkey"], {
    cwd: ctx.recordWorktree,
  });
  if (configured !== null && configured !== "" && (await exists(configured))) return configured;
  const { homedir } = await import("node:os");
  for (const name of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
    const candidate = join(homedir(), ".ssh", name);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

/** The network manifest from `main`, which carries the authenticity mode. */
export async function readManifest(ctx: AuthenticityContext): Promise<NetManifest | null> {
  const path = join(ctx.recordWorktree, ".komnet/net.yaml");
  if (!(await exists(path))) return null;
  try {
    return parseNetManifest(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export async function authenticityMode(ctx: AuthenticityContext): Promise<AuthenticityMode> {
  // Absent or unreadable manifest → the documented default, not "none".
  return (await readManifest(ctx))?.authenticity ?? "git";
}
