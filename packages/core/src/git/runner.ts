import { spawn } from "node:child_process";
import { GitError } from "../errors.ts";

export interface GitRunOptions {
  cwd: string;
  /** Hard ceiling; the child is killed on expiry. Network ops override this. */
  timeoutMs?: number;
  /** Written to stdin, then closed. Used for commit messages via `-F -`. */
  input?: string;
  /** Extra environment, merged over the hardened defaults. */
  env?: Readonly<Record<string, string>>;
}

export interface GitResult {
  stdout: string;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Network operations legitimately take longer than local ones. */
export const NETWORK_TIMEOUT_MS = 120_000;

/**
 * Environment hardening applied to every invocation.
 *
 * `GIT_TERMINAL_PROMPT=0` is the important one: without it a daemon hits an
 * expired credential and blocks forever on an invisible prompt, which presents
 * as "sync silently stopped" and is miserable to diagnose. Failing loudly with
 * an auth error is strictly better.
 */
function hardenedEnv(extra?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Never block waiting for input nobody can see.
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: process.env["GIT_ASKPASS"] ?? "",
    // Stable, parseable output regardless of the user's locale.
    LC_ALL: "C",
    LANG: "C",
    // Do not take the index lock for read-only operations; a concurrent
    // foreground git in the same worktree should not make our reads fail.
    GIT_OPTIONAL_LOCKS: "0",
    ...extra,
  };
}

/**
 * Global git flags applied to every invocation.
 *
 * Protocol v2 matters specifically for `ls-remote`: it lets the server filter
 * by ref prefix, which is what keeps the poll payload proportional to the rooms
 * we asked about rather than to every ref in the repository (ADR 0008).
 */
const GLOBAL_FLAGS = [
  "-c",
  "protocol.version=2",
  "-c",
  "core.quotePath=false",
  "-c",
  "advice.detachedHead=false",
  // Never GPG-sign komnet's own commits, even when the user has
  // `commit.gpgsign = true` globally — which is common.
  //
  // These are machine-generated protocol writes, not authored history. Signing
  // them launches `pinentry` on every single message: in a daemon with no TTY
  // that hangs or fails outright, and even interactively it is slow enough to
  // exhaust memory under load. Message authenticity has its own mechanism
  // (`authenticity: signed`, SSH signatures over the canonical form), which is
  // independent of how the commit object happens to be signed.
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
];

/**
 * Thin, typed wrapper over the user's own `git` binary.
 *
 * Shelling out rather than reimplementing git in JS is deliberate: the user's
 * credential helper, SSH agent, proxy settings, and host config all work
 * unchanged. A JS git implementation would have to re-solve authentication, and
 * would solve it worse.
 */
export class GitRunner {
  readonly gitPath: string;

  constructor(gitPath = "git") {
    this.gitPath = gitPath;
  }

  async run(args: readonly string[], options: GitRunOptions): Promise<GitResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fullArgs = [...GLOBAL_FLAGS, ...args];

    return await new Promise<GitResult>((resolve, reject) => {
      const child = spawn(this.gitPath, fullArgs, {
        cwd: options.cwd,
        env: hardenedEnv(options.env),
        // No shell: arguments are passed as an array, so nothing in a message
        // body or room name can ever be interpreted as a command.
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, timeoutMs);
      timer.unref();

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));

      child.on("error", (cause: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new GitError({
            args: fullArgs,
            exitCode: null,
            signal: null,
            stderr: cause.message,
            stdout,
            cwd: options.cwd,
          }),
        );
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(
          new GitError({
            args: fullArgs,
            exitCode: code,
            signal,
            stderr,
            stdout,
            cwd: options.cwd,
          }),
        );
      });

      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    });
  }

  /** Run and return trimmed stdout. */
  async text(args: readonly string[], options: GitRunOptions): Promise<string> {
    return (await this.run(args, options)).stdout.trim();
  }

  /** Run and split stdout into non-empty lines. */
  async lines(args: readonly string[], options: GitRunOptions): Promise<string[]> {
    const { stdout } = await this.run(args, options);
    return stdout.split("\n").filter((line) => line.length > 0);
  }

  /** Run, returning null instead of throwing. For genuinely optional queries. */
  async tryText(args: readonly string[], options: GitRunOptions): Promise<string | null> {
    try {
      return await this.text(args, options);
    } catch (error) {
      if (error instanceof GitError) return null;
      throw error;
    }
  }
}
