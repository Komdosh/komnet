import type { SecretFinding } from "./scanner/secrets.ts";

/**
 * A caught value rendered as a message.
 *
 * `catch` binds `unknown`, so every reporting path needs this; it had been
 * written out nine times across four packages under three different names.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Lines git prints ABOVE the real cause on a transport failure.
 *
 * `fatal: Could not read from remote repository.` is the classic: git emits it
 * on every unreachable remote, so a diagnostic that leads with it tells the
 * user their remote is unreachable — which they already knew — instead of
 * whether it was a key, a host, or the network.
 */
const GIT_PREAMBLE = ["fatal: Could not read from remote repository", "fatal: Could not read"];

/**
 * The first line of a git failure that actually says something.
 *
 * Shared so the same failure reads the same everywhere. It did not, and the
 * split was invisible: `komnet doctor` skipped the preamble and named the real
 * cause, while the queued-send reason behind `komnet status` did not — so the
 * surface people check constantly gave the useless half of the message and the
 * one they check rarely gave the good one.
 *
 * Returns null when every line is preamble, which is a real case: the caller
 * then falls back to the whole text, because a vague diagnostic beats an empty
 * one.
 */
export function firstMeaningfulLine(text: string): string | null {
  const line = text
    .split("\n")
    .find(
      (candidate) =>
        candidate.trim() !== "" && !GIT_PREAMBLE.some((noise) => candidate.startsWith(noise)),
    );
  return line ?? null;
}

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
    // `[rejected]` alone is also emitted for policy hooks, protected branches,
    // and other permanent failures. Treat only ancestry-specific diagnostics as
    // a compare-and-swap loss; everything else must surface to the caller.
    return /\b(non-fast-forward|fetch first)\b/i.test(this.stderr);
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

  /**
   * The remote could not be reached or read at all.
   *
   * Indistinguishable, from git's output, between "the host is down" and "the
   * URL is wrong". Treated as retryable and therefore queueable, because losing
   * a message to a typo is worse than holding one: a bad URL still surfaces
   * loudly through `komnet status` (queued count) and `komnet doctor`.
   */
  get isRemoteUnreachable(): boolean {
    return /(could not read from remote repository|does not appear to be a git repository|repository not found|no such (file or directory|host))/i.test(
      this.stderr,
    );
  }
}

/** The push loop exhausted its attempts; the message stays queued. */
export class PushExhaustedError extends Error {
  readonly attempts: number;

  constructor(attempts: number, cause?: unknown) {
    super(`push did not converge after ${String(attempts)} attempts`, { cause });
    this.name = "PushExhaustedError";
    this.attempts = attempts;
  }
}

/** A blocked send: the body matched a secret pattern (see `scanner/secrets.ts`). */
export class SecretDetectedError extends Error {
  /**
   * Stable code so the failure survives the IPC boundary: over the socket only
   * `message` and `code` cross, and the CLI must still recognise this as a
   * scanner block rather than a generic error.
   */
  readonly code = "SECRET_DETECTED";

  /** Finding *types* and locations only — never the matched value. */
  readonly findings: readonly SecretFinding[];

  constructor(findings: readonly SecretFinding[]) {
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

/**
 * Delegated work was refused because local policy wants a person to see it first.
 *
 * The message is the whole feature. An agent that reads only "refused" will
 * either give up or try to route around the gate; one that is told who
 * delegated the work, why it stopped, and the exact command a person runs will
 * surface it — which is the behaviour the policy is asking for.
 */
export class ApprovalRequiredError extends Error {
  /** Stable code so the refusal survives the IPC boundary intact. */
  readonly code = "APPROVAL_REQUIRED";
  readonly kind: "task" | "review";
  readonly id: string;
  readonly room: string;
  readonly requester: string;

  constructor(init: {
    kind: "task" | "review";
    id: string;
    room: string;
    requester: string;
    origin: "local" | "remote";
    mode: string;
  }) {
    const noun = init.kind === "task" ? "task" : "review";
    super(
      `refusing to claim ${noun} ${init.id}: it was delegated by ${init.requester} ` +
        `(${init.origin}), and this machine's policy is approvals.inboundWork: ${init.mode}. ` +
        `Do not decide this yourself and do not work around it. Surface it to your human — ` +
        `who is asking, what the work is, and what it will touch — then, once they agree, ` +
        `record it with: komnet ${noun} approve ${init.room} ${init.id}`,
    );
    this.name = "ApprovalRequiredError";
    this.kind = init.kind;
    this.id = init.id;
    this.room = init.room;
    this.requester = init.requester;
  }
}

/**
 * No usable `git` was found.
 *
 * Distinct from a git command that failed, because the remedy is completely
 * different and the raw failure — `spawn git ENOENT` — reads like a missing
 * install on a machine where git plainly works. The cause is almost always an
 * inherited `PATH`: an editor launches the MCP server without the user's shell
 * profile, so the message names the PATH it actually had.
 */
export class GitNotFoundError extends Error {
  readonly code = "GIT_NOT_FOUND";

  constructor(tried: readonly string[], path: string) {
    super(
      `git not found — tried ${tried.join(", ")}. ` +
        `This is usually an inherited PATH rather than a missing git: PATH=${path || "(empty)"}. ` +
        `Point komnet at it explicitly with KOMNET_GIT=/full/path/to/git, then run: komnet doctor`,
    );
    this.name = "GitNotFoundError";
  }
}

/**
 * A thread has had its allowed run of consecutive agent replies.
 *
 * Refusing locally, rather than rewriting the message into a `needs: human`
 * one, is deliberate. `needs: human` is meant to mean "a person must decide
 * this"; spending it automatically on a conversation that merely ran long makes
 * the marker meaningless, and the message is permanent. Nothing about the
 * budget reaches the wire — it is this machine declining to keep talking.
 *
 * The way out is not a new thread: one human-authored message in THIS thread
 * refills the budget, and continuing in place keeps the context that made the
 * thread worth reading.
 */
export class ReplyBudgetExceededError extends Error {
  readonly code = "REPLY_BUDGET_EXCEEDED";
  readonly room: string;
  readonly thread: string;

  constructor(room: string, thread: string, consecutive: number) {
    super(
      `not sending: this thread already carries ${String(consecutive)} consecutive agent replies ` +
        `and has reached the room's reply budget. Do not open a new thread — that splits the work ` +
        `and loses the context. Surface it to your human; one message from them in this thread ` +
        `refills the budget: komnet answer <id> "<their words>" --as-human (thread ${thread}, room ${room})`,
    );
    this.name = "ReplyBudgetExceededError";
    this.room = room;
    this.thread = thread;
  }
}

/**
 * The identity this command would act as is not the one the caller expected.
 *
 * A message carries `from`, permanently, in a log the whole team reads. Sending
 * one under the wrong agent id is not a typo that can be corrected — it can only
 * be followed by a second message admitting the first was misattributed, which
 * is exactly what happened in the field.
 *
 * So an asserted identity fails closed. `--agent` and `KOMNET_AGENT` are not a
 * hint about who you probably are; they are a claim checked before anything is
 * written.
 */
export class IdentityMismatchError extends Error {
  readonly code = "IDENTITY_MISMATCH";
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string, home: string) {
    super(
      `refusing to act as ${actual} when ${expected} was asserted. ` +
        `This home (${home}) belongs to ${actual}, so anything written here would be ` +
        `attributed to ${actual} permanently. Provision ${expected} with ` +
        `'komnet agent add ${expected} --repo <url>', or drop the assertion.`,
    );
    this.name = "IdentityMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * This machine holds several identities and the command did not say which.
 *
 * Only writes are refused. Reading as the wrong agent shows a confusing inbox;
 * writing as the wrong agent puts someone else's name on a permanent message.
 */
export class AmbiguousIdentityError extends Error {
  readonly code = "AMBIGUOUS_IDENTITY";
  readonly candidates: readonly string[];

  constructor(command: string, fallback: string, candidates: readonly string[]) {
    super(
      `refusing to '${command}' without an explicit identity: this machine has ` +
        `${String(candidates.length)} provisioned agent(s) (${candidates.join(", ")}) and no ` +
        `KOMNET_HOME is set, so this would be written as ${fallback} — whoever that happens ` +
        `to be. Say who you are: komnet --agent <id> ${command} …, or export KOMNET_AGENT=<id>.`,
    );
    this.name = "AmbiguousIdentityError";
    this.candidates = [...candidates];
  }
}

/**
 * A read was asked about a room this agent does not follow.
 *
 * Routing only delivers within subscribed rooms, so the local cache holds
 * nothing for any other one. Answering `[]` would report the room as quiet —
 * which an agent then tells its human — when the truth is that this machine was
 * never listening. An empty result and "you are not in that room" must not look
 * the same.
 */
export class NotSubscribedError extends Error {
  readonly code = "NOT_SUBSCRIBED";
  readonly room: string;

  constructor(room: string, verb: string) {
    super(
      `cannot ${verb} ${room}: this agent does not subscribe to it, so nothing from it ` +
        `has ever reached this machine. An empty result here would mean "not listening", ` +
        `not "nothing was said". Join it first: komnet room join ${room}`,
    );
    this.name = "NotSubscribedError";
    this.room = room;
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
