/** A `git` invocation that exited non-zero. */
export class GitError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly cwd: string;

  constructor(init: {
    args: readonly string[];
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    stdout: string;
    cwd: string;
  }) {
    const detail = init.stderr.trim() || init.stdout.trim() || "no output";
    super(`git ${init.args.join(" ")} failed (${String(init.exitCode ?? init.signal)}): ${detail}`);
    this.name = "GitError";
    this.args = init.args;
    this.exitCode = init.exitCode;
    this.signal = init.signal;
    this.stderr = init.stderr;
    this.stdout = init.stdout;
    this.cwd = init.cwd;
  }

  /**
   * Whether the remote refused the push because our ref was behind.
   *
   * This is the expected outcome of a concurrent send, not a fault — it drives
   * the rebase-retry loop rather than surfacing to the caller.
   */
  get isNonFastForward(): boolean {
    return /\b(non-fast-forward|fetch first|rejected)\b/i.test(this.stderr);
  }

  /** Auth failures need a human, so the retry loop must not spin on them. */
  get isAuthFailure(): boolean {
    return /(permission denied|authentication failed|could not read Username|access denied)/i.test(
      this.stderr,
    );
  }

  /** Transient network trouble: worth retrying, unlike auth. */
  get isNetworkFailure(): boolean {
    return /(could not resolve host|connection timed out|connection refused|network is unreachable|early EOF|RPC failed)/i.test(
      this.stderr,
    );
  }
}

/** The push loop exhausted its attempts; the message stays queued. */
export class PushExhaustedError extends Error {
  readonly attempts: number;

  constructor(attempts: number, cause: unknown) {
    super(`push did not converge after ${String(attempts)} attempts`, { cause });
    this.name = "PushExhaustedError";
    this.attempts = attempts;
  }
}

/** A blocked send: the body matched a secret pattern (see `scanner/secrets.ts`). */
export class SecretDetectedError extends Error {
  /** Finding *types* and locations only — never the matched value. */
  readonly findings: readonly { rule: string; line: number }[];

  constructor(findings: readonly { rule: string; line: number }[]) {
    const summary = findings.map((f) => `${f.rule} (line ${String(f.line)})`).join(", ");
    super(
      `refusing to send: possible secret detected — ${summary}. ` +
        `Git history is permanent; a leaked credential can only be rotated, not recalled. ` +
        `Remove it, or resend with an explicit reason if this is a false positive.`,
    );
    this.name = "SecretDetectedError";
    this.findings = findings;
  }
}

/** A protocol invariant was violated by data already in the repository. */
export class InvariantViolationError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} (${path})`);
    this.name = "InvariantViolationError";
    this.path = path;
  }
}
