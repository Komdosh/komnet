import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { daemonEntryFor } from "../src/daemon-cmd.ts";

/**
 * Regression coverage for an install-breaking bug.
 *
 * A release install is ONE self-contained binary — `install.sh` never ships a
 * `komnetd`. The resolver nevertheless fell through to spawning `komnetd`, so
 * `komnet daemon start` could only ever fail with `spawn komnetd ENOENT`, and
 * `komnet daemon install` wrote a supervisor unit naming that same missing
 * binary, re-failing at every login. Presence stayed `away` forever as a
 * consequence, because it is the daemon that publishes the live transition.
 *
 * It survived because a workspace test run is always plain `node`, which takes
 * the first branch — the broken path is the one only real users reached.
 */
describe("daemon entry resolution", () => {
  it("runs the packaged binary as its own daemon host", () => {
    const entry = daemonEntryFor("/Users/someone/.local/bin/komnet", undefined, null);

    assert.deepEqual(entry, {
      command: "/Users/someone/.local/bin/komnet",
      args: ["daemon", "run"],
    });
    assert.notEqual(
      entry.command,
      "komnetd",
      "a release install ships no komnetd, so resolving one can only ENOENT",
    );
  });

  it("still prefers the workspace daemon script when one is next to the CLI", () => {
    const entry = daemonEntryFor(
      "/usr/local/bin/node",
      "/repo/packages/cli/dist/bin.js",
      "/repo/packages/daemon/dist/bin.js",
    );

    assert.deepEqual(entry, {
      command: "/usr/local/bin/node",
      args: ["/repo/packages/daemon/dist/bin.js"],
    });
  });

  it("falls back to PATH only for a plain-node run with no sibling", () => {
    assert.deepEqual(
      daemonEntryFor("/usr/local/bin/node", "/repo/packages/cli/dist/bin.js", null),
      {
        command: "komnetd",
        args: [],
      },
    );
    assert.deepEqual(daemonEntryFor("/usr/bin/node", undefined, null), {
      command: "komnetd",
      args: [],
    });
  });

  it("treats a node-named binary on Windows the same way", () => {
    assert.equal(
      daemonEntryFor("C:\\Program Files\\nodejs\\node.exe", undefined, null).command,
      "komnetd",
    );
    assert.equal(
      daemonEntryFor("C:\\Users\\someone\\komnet.exe", undefined, null).args[0],
      "daemon",
      "a packaged Windows binary must host the daemon itself too",
    );
  });
});
