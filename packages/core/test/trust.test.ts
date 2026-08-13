import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { defaultIdentity } from "../src/config.ts";
import { GitNotFoundError, NotSubscribedError } from "../src/errors.ts";
import { GitRunner } from "../src/git/runner.ts";
import { Layout } from "../src/layout.ts";
import { Network } from "../src/network.ts";

const exec = promisify(execFile);

process.env["GIT_AUTHOR_NAME"] = "komnet test";
process.env["GIT_AUTHOR_EMAIL"] = "test@komnet.invalid";
process.env["GIT_COMMITTER_NAME"] = "komnet test";
process.env["GIT_COMMITTER_EMAIL"] = "test@komnet.invalid";

/**
 * Reads answer from a local cache, so an empty result has two very different
 * causes: nothing was said, or nothing reached this machine. Reporting the
 * first when the second is true is how an agent tells its human "no new
 * messages" while dozens sit unfetched on the remote. That happened in the
 * field; these are the guards.
 */
describe("a read never lies", () => {
  let tmp: string;
  let remote: string;
  let network: Network;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "komnet-trust-"));
    remote = join(tmp, "transport.git");
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
    network = (
      await Network.init({
        layout: new Layout(join(tmp, "home")),
        networkId: "acme",
        remote,
        identity: defaultIdentity({ id: "alice-codex" }),
      })
    ).network;
    await network.createRoom("architecture");
  });

  after(async () => {
    network.close();
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("refuses to answer for a room this agent does not follow", () => {
    // The reported failure: an agent queried a room it was not subscribed to,
    // got `[]`, and concluded the room was quiet.
    assert.throws(
      () => network.inbox({ room: "not-joined" }),
      (error: unknown) =>
        error instanceof NotSubscribedError &&
        error.code === "NOT_SUBSCRIBED" &&
        // The message must carry the fix, not just the complaint.
        /komnet room join not-joined/.test(error.message),
    );
  });

  it("refuses to read, search, or send in an unfollowed room", async () => {
    await assert.rejects(network.read("not-joined"), /does not subscribe/);
    await assert.rejects(network.history("not-joined"), /does not subscribe/);
    await assert.rejects(network.search("anything", { room: "not-joined" }), /does not subscribe/);
    // Sending into a room you do not follow posts a question whose answer can
    // never come back to you.
    await assert.rejects(network.send("not-joined", { body: "hello" }), /does not subscribe/);
  });

  it("still answers freely for rooms it does follow", async () => {
    assert.deepEqual(network.inbox({ room: "architecture" }), []);
    await assert.doesNotReject(network.read("architecture"));
  });

  it("reports a never-synced network as degraded, not as quiet", () => {
    const fresh = network.health();
    assert.equal(fresh.degraded, true, "never having synced is when [] is least trustworthy");
    assert.equal(fresh.lastSyncAt, null);
    assert.equal(fresh.ageSeconds, null);
  });

  it("clears degraded once a sync succeeds", async () => {
    await network.sync();
    const healthy = network.health();
    assert.equal(healthy.degraded, false);
    assert.ok(healthy.lastSyncAt !== null);
    assert.equal(healthy.reason, undefined);
    assert.ok((healthy.ageSeconds ?? 99) < 30);
  });

  it("marks the view degraded when the transport breaks, and says why", async () => {
    await rename(remote, `${remote}.gone`);
    try {
      await assert.rejects(network.sync(), "a missing remote must surface to the caller");

      const broken = network.health();
      assert.equal(broken.degraded, true);
      assert.ok(broken.reason !== undefined, "a degraded view must carry the reason");
      assert.ok(broken.failingSince !== undefined, "and how long it has been true");
      // The inbox still answers — it just no longer claims to be complete.
      assert.deepEqual(network.inbox(), []);
    } finally {
      await rename(`${remote}.gone`, remote);
    }

    // And recovery clears it, so the warning cannot get stuck on.
    await network.sync();
    assert.equal(network.health().degraded, false);
    assert.equal(network.health().reason, undefined);
  });
});

describe("a long-lived process follows the config", () => {
  it("picks up a room joined after the backend was created", async () => {
    // An MCP server lives for a whole editor session. Binding config once meant
    // it could answer for a world the config no longer described — the reported
    // failure was MCP and CLI reporting different networks at the same moment.
    const tmp = await mkdtemp(join(tmpdir(), "komnet-reload-"));
    try {
      const remote = join(tmp, "transport.git");
      await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
      const home = join(tmp, "home");
      const cli = join(import.meta.dirname, "..", "..", "cli", "dist", "bin.js");
      const run = async (...args: string[]): Promise<string> => {
        const { stdout } = await exec(process.execPath, [cli, ...args], {
          env: { ...process.env, KOMNET_HOME: home, NO_COLOR: "1" },
        });
        return stdout;
      };

      await run("init", "--repo", remote, "--network", "acme", "--agent", "alice-codex");
      await run("room", "create", "architecture");

      const { openBackend } = await import("../../daemon/src/backend.ts");
      const backend = await openBackend({ layout: new Layout(home), forceDirect: true });
      try {
        // Built before `payments` existed, so this must refuse.
        await assert.rejects(backend.call("read", { room: "payments" }), /does not subscribe/);

        // A separate process joins the room, rewriting config.yaml.
        await run("room", "create", "payments");

        // The long-lived backend must now see it rather than insisting it is absent.
        await assert.doesNotReject(
          backend.call("read", { room: "payments" }),
          "a backend that never re-reads config serves a world that no longer exists",
        );
      } finally {
        await backend.close();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe("finding git", () => {
  it("resolves git even when PATH does not contain it", async () => {
    // An editor launches the MCP server without the user's shell profile, so
    // `spawn("git")` fails on a machine with a perfectly good git installed.
    const original = process.env["PATH"];
    process.env["PATH"] = "/nonexistent";
    try {
      const resolved = await new GitRunner().resolveGitPath();
      assert.match(resolved, /git$/);
      // And it actually runs, rather than merely looking plausible.
      const { stdout } = await new GitRunner(resolved).run(["--version"], { cwd: process.cwd() });
      assert.match(stdout, /^git version/);
    } finally {
      process.env["PATH"] = original;
    }
  });

  it("names the PATH and the escape hatch when nothing works", () => {
    const error = new GitNotFoundError(["git", "/usr/bin/git"], "/nonexistent");
    assert.equal(error.code, "GIT_NOT_FOUND");
    assert.match(error.message, /PATH=\/nonexistent/);
    assert.match(error.message, /KOMNET_GIT=/);
    assert.match(error.message, /komnet doctor/);
  });
});

describe("a local transport accepts pushes", () => {
  it("sets receive.denyCurrentBranch=updateInstead on a non-bare local remote", async () => {
    // The reported failure: an IDE held `room/<id>` checked out in the transport
    // repo, and every send to that room was rejected by git's default.
    const tmp = await mkdtemp(join(tmpdir(), "komnet-nonbare-"));
    try {
      const transport = join(tmp, "transport");
      await exec("git", ["init", "--quiet", "--initial-branch=main", transport]);
      await exec("git", ["-C", transport, "commit", "--quiet", "--allow-empty", "-m", "seed"]);

      const network = (
        await Network.init({
          layout: new Layout(join(tmp, "home")),
          networkId: "acme",
          remote: transport,
          identity: defaultIdentity({ id: "alice-codex" }),
        })
      ).network;
      network.close();

      const { stdout } = await exec("git", [
        "-C",
        transport,
        "config",
        "--get",
        "receive.denyCurrentBranch",
      ]);
      assert.equal(stdout.trim(), "updateInstead");
    } finally {
      await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe("knowing whether a message will land", () => {
  let tmp: string;
  let alice: Network;
  let bob: Network;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "komnet-delivery-"));
    const remote = join(tmp, "transport.git");
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
    alice = (
      await Network.init({
        layout: new Layout(join(tmp, "alice")),
        networkId: "acme",
        remote,
        identity: defaultIdentity({ id: "alice-codex" }),
      })
    ).network;
    await alice.createRoom("architecture");
    await alice.createRoom("payments");
    bob = (
      await Network.init({
        layout: new Layout(join(tmp, "bob")),
        networkId: "acme",
        remote,
        identity: defaultIdentity({ id: "bob-claude" }),
      })
    ).network;
    await bob.joinRoom("architecture");
    await alice.sync();
  });

  after(async () => {
    alice.close();
    bob.close();
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("publishes which rooms an agent follows", async () => {
    const card = (await alice.listAgents()).find((c) => c.id === "bob-claude");
    assert.deepEqual(card?.subscriptions, ["architecture"]);
  });

  it("counts rooms it created, not only rooms it joined", async () => {
    // Creating a room subscribes exactly as joining one does. Announcing only
    // on join published a room's own creator as not following it — so peers
    // were told a message to them could not land, which is worse than silence.
    const own = (await alice.listAgents()).find((c) => c.id === "alice-codex");
    assert.deepEqual(own?.subscriptions, ["architecture", "payments"]);
  });

  it("says a mention will land, and that another will not", async () => {
    const [reaches] = await alice.forecastDelivery("architecture", ["bob-claude"]);
    assert.equal(reaches?.outlook, "reaches");

    // The failure this exists for: alice asks bob in a room bob never joined.
    // Routing silently drops it, and the silence looks exactly like being
    // ignored — a question can sit for a day with both sides waiting.
    const [misses] = await alice.forecastDelivery("payments", ["bob-claude"]);
    assert.equal(misses?.outlook, "misses");
    assert.match(misses?.reason ?? "", /does not follow #payments/);
  });

  it("says unknown rather than guessing, for a stranger or an older client", async () => {
    const [stranger] = await alice.forecastDelivery("architecture", ["nobody-here"]);
    assert.equal(stranger?.outlook, "unknown", "an unknown id is not a confident 'misses'");
    assert.match(stranger?.reason ?? "", /no agent card/);

    // A card from a client that predates published subscriptions carries no
    // list. Treating that as "subscribes to nothing" would assert a peer who is
    // reading fine cannot hear you.
    const legacy = { ...((await alice.listAgents())[0] as Record<string, unknown>) };
    delete legacy["subscriptions"];
    assert.equal(legacy["subscriptions"], undefined);
  });

  it("keeps the published list current when rooms are joined and left", async () => {
    await bob.joinRoom("payments");
    await alice.sync();
    assert.equal(
      (await alice.forecastDelivery("payments", ["bob-claude"]))[0]?.outlook,
      "reaches",
      "joining must update what peers believe, or the forecast is worse than none",
    );

    await bob.leaveRoom("payments");
    await alice.sync();
    assert.equal((await alice.forecastDelivery("payments", ["bob-claude"]))[0]?.outlook, "misses");
  });

  it("never forecasts @room or this agent itself", async () => {
    assert.deepEqual(await alice.forecastDelivery("architecture", ["@room", "alice-codex"]), []);
  });
});
