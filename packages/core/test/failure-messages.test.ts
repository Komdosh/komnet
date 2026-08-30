import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { firstMeaningfulLine } from "../src/errors.ts";
import { conciseFailure } from "../src/network.ts";

/**
 * The reason a queued message shows when the remote could not be reached.
 *
 * `komnet status` renders this, so it is read far more often than any other
 * diagnostic — and it was the one saying the least. Both surfaces now share
 * `firstMeaningfulLine`, and these fixtures are real `git` output.
 */
describe("conciseFailure", () => {
  it("reports the transport's cause, not komnet's conclusion about it", () => {
    // A push that exhausts its retry ladder wraps the real failure as `cause`.
    // "did not converge after 3 attempts" is true and useless; the cause is
    // the thing a person can act on.
    const exhausted = new Error("push did not converge after 3 attempts", {
      cause: new Error("git push failed (128): Permission denied (publickey)."),
    });
    assert.equal(conciseFailure(exhausted), "Permission denied (publickey).");
  });

  it("names the real cause rather than git's unreachable-remote preamble", () => {
    // The regression this pins: `komnet doctor` skipped the preamble and this
    // did not, so one failure produced a useful sentence in the command people
    // run rarely and a useless one in the command they run constantly.
    const unreachable = new Error(
      "git push failed (128): fatal: Could not read from remote repository.\n" +
        "Permission denied (publickey).",
    );
    assert.equal(conciseFailure(unreachable), "Permission denied (publickey).");
  });

  it("falls back to the preamble when it is genuinely all git said", () => {
    const bare = new Error("git push failed (128): fatal: Could not read from remote repository.");
    assert.equal(conciseFailure(bare), "fatal: Could not read from remote repository.");
  });

  it("bounds the length so one runaway line cannot fill the status output", () => {
    const long = new Error(`git push failed (128): ${"x".repeat(400)}`);
    const result = conciseFailure(long);
    assert.equal(result.length, 200);
    assert.ok(result.endsWith("…"), "a truncated message must show that it was truncated");
  });

  it("survives a non-Error, because catch binds unknown", () => {
    assert.equal(typeof conciseFailure("plain string"), "string");
    assert.equal(typeof conciseFailure(null), "string");
  });
});

describe("firstMeaningfulLine", () => {
  it("skips blank lines and git's preamble", () => {
    assert.equal(
      firstMeaningfulLine("\n\nfatal: Could not read from remote repository.\nreal cause"),
      "real cause",
    );
  });

  it("only skips the preamble when it starts the line", () => {
    assert.equal(
      firstMeaningfulLine("server said: fatal: Could not read from remote"),
      "server said: fatal: Could not read from remote",
    );
  });

  it("returns null when there is nothing but preamble, never an empty string", () => {
    // Null is what lets the caller fall back to the whole text. An empty
    // string would render as a blank diagnostic, which is worse than a vague one.
    assert.equal(firstMeaningfulLine("fatal: Could not read from remote repository."), null);
    assert.equal(firstMeaningfulLine(""), null);
    assert.equal(firstMeaningfulLine("\n  \n"), null);
  });
});
