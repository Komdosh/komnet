import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { conciseGitFailure, sshHostOf } from "../src/diagnostics.ts";

/**
 * The sentence a person reads when their remote is unreachable.
 *
 * Untested until now, which is backwards: this code only ever runs when
 * something has already gone wrong, so a regression here is invisible in
 * normal use and lands squarely on someone who is already stuck. The fixtures
 * are real `git` output, not invented strings — including the failure this
 * machine hit mid-session while pushing.
 */
describe("conciseGitFailure", () => {
  it("reports what git said, not komnet's own invocation", () => {
    // The flags are ours. Leading with them buries the one actionable line.
    const wrapped = new Error(
      "git -c protocol.version=2 -c core.quotePath=false ls-remote failed (128): " +
        "Permission denied (publickey).\nfatal: Could not read from remote repository.",
    );
    assert.equal(conciseGitFailure(wrapped), "Permission denied (publickey).");
  });

  it("skips git's boilerplate to reach the real cause", () => {
    // Observed output. `fatal: Could not read from remote repository.` is
    // printed above the cause on every transport failure, so leading with it
    // tells the user their remote is unreachable — which they knew.
    const observed = new Error(
      "git fetch origin failed (128): fatal: Could not read from remote repository.\n" +
        "banner exchange: Connection to 4.225.11.194 port 22: Broken pipe",
    );
    assert.equal(
      conciseGitFailure(observed),
      "banner exchange: Connection to 4.225.11.194 port 22: Broken pipe",
    );
  });

  it("falls back to the boilerplate rather than saying nothing", () => {
    // When the useless line is ALL there is, an empty diagnostic would be
    // worse than a vague one.
    const bare = new Error("git push failed (128): fatal: Could not read from remote repository.");
    assert.equal(conciseGitFailure(bare), "fatal: Could not read from remote repository.");
  });

  it("only drops the boilerplate when it begins the line", () => {
    const quoted = new Error("git failed (128): server said: fatal: Could not read from remote");
    assert.equal(conciseGitFailure(quoted), "server said: fatal: Could not read from remote");
  });

  it("passes through a message that carries no komnet wrapper", () => {
    assert.equal(
      conciseGitFailure(new Error("host key verification failed")),
      "host key verification failed",
    );
  });

  it("bounds the length, so one runaway line cannot flood a doctor report", () => {
    const long = new Error(`git failed (128): ${"x".repeat(500)}`);
    assert.equal(conciseGitFailure(long).length, 160);
  });

  it("survives being handed something that is not an Error", () => {
    // `catch` binds `unknown`; a thrown string or null must not crash doctor.
    assert.equal(typeof conciseGitFailure("plain string"), "string");
    assert.equal(typeof conciseGitFailure(null), "string");
    assert.equal(typeof conciseGitFailure(undefined), "string");
  });
});

describe("sshHostOf", () => {
  it("reads the identity out of an scp-style remote", () => {
    assert.equal(sshHostOf("git@github.com:Komdosh/komnet.git"), "git@github.com");
    assert.equal(sshHostOf("git@gitlab.example.com:acme/komnet.git"), "git@gitlab.example.com");
  });

  it("reads it out of an ssh:// url", () => {
    assert.equal(sshHostOf("ssh://git@github.com/Komdosh/komnet.git"), "git@github.com");
    assert.equal(sshHostOf("ssh://git@host:2222/acme/komnet.git"), "git@host:2222");
  });

  it("returns null for remotes with no SSH identity to probe", () => {
    // The caller prints `ssh -T <host>` as the next step; suggesting one for an
    // https or local remote would send the user to test the wrong thing.
    assert.equal(sshHostOf("https://github.com/Komdosh/komnet.git"), null);
    assert.equal(sshHostOf("/srv/git/komnet.git"), null);
    assert.equal(sshHostOf("../transport.git"), null);
    assert.equal(sshHostOf("file:///srv/git/komnet.git"), null);
  });
});
