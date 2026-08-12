import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

const exec = promisify(execFile);

/**
 * The real built entry point. Spawned as a subprocess rather than called
 * in-process: capturing stdout by replacing `process.stdout.write` also
 * swallows the test reporter's own output, and spawning exercises argv parsing
 * and exit codes exactly as an agent or shell would see them.
 */
const CLI = join(import.meta.dirname, "..", "dist", "bin.js");

process.env["GIT_AUTHOR_NAME"] = "komnet test";
process.env["GIT_AUTHOR_EMAIL"] = "test@komnet.invalid";
process.env["GIT_COMMITTER_NAME"] = "komnet test";
process.env["GIT_COMMITTER_EMAIL"] = "test@komnet.invalid";
process.env["NO_COLOR"] = "1";

let tmp: string;
let remote: string;
let aliceHome: string;
let bobHome: string;
let product: string;
let productBaseRev: string;
let productHeadRev: string;

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** Invoke the CLI as a given agent, isolated by `KOMNET_HOME`. */
async function komnet(home: string, ...args: string[]): Promise<Result> {
  const env = { ...process.env, KOMNET_HOME: home, NO_COLOR: "1" };
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const alice = (...args: string[]) => komnet(aliceHome, ...args);
const bob = (...args: string[]) => komnet(bobHome, ...args);

function parseJson<T>(result: Result): T {
  assert.equal(result.code, 0, `expected success, got ${String(result.code)}: ${result.stderr}`);
  return JSON.parse(result.stdout) as T;
}

before(async () => {
  try {
    await access(CLI);
  } catch {
    throw new Error(`${CLI} is missing — run 'pnpm build' before 'pnpm test'`);
  }
  tmp = await mkdtemp(join(tmpdir(), "komnet-cli-"));
  remote = join(tmp, "transport.git");
  aliceHome = join(tmp, "alice");
  bobHome = join(tmp, "bob");
  product = join(tmp, "product");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  await exec("git", ["init", "--quiet", "--initial-branch=main", product]);
  await mkdir(join(product, "src", "refunds"), { recursive: true });
  await writeFile(
    join(product, "src", "refunds", "service.ts"),
    "export const retryOwner = 'request';\n",
    "utf8",
  );
  await exec("git", ["-C", product, "add", "src/refunds/service.ts"]);
  await exec("git", [
    "-C",
    product,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "base",
  ]);
  productBaseRev = (await exec("git", ["-C", product, "rev-parse", "HEAD"])).stdout.trim();
  await writeFile(
    join(product, "src", "refunds", "service.ts"),
    "export const retryOwner = 'ledger';\n",
    "utf8",
  );
  await exec("git", [
    "-C",
    product,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-am",
    "head",
  ]);
  productHeadRev = (await exec("git", ["-C", product, "rev-parse", "HEAD"])).stdout.trim();
});

after(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("komnet CLI, end to end", () => {
  it("initialises a network on an empty remote", async () => {
    const result = await alice(
      "init",
      "--repo",
      remote,
      "--network",
      "acme",
      "--agent",
      "alice-cursor",
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /initialised a new network/);

    // The manifest must exist on main — this is what makes the repo self-describing.
    const { stdout } = await exec("git", ["-C", remote, "show", "main:.komnet/net.yaml"]);
    assert.match(stdout, /id: acme/);
  });

  it("creates a room as an orphan branch carrying only that room", async () => {
    const result = await alice("room", "create", "architecture", "--title", "Architecture");
    assert.equal(result.code, 0, result.stderr);

    const { stdout: refs } = await exec("git", [
      "-C",
      remote,
      "for-each-ref",
      "--format=%(refname)",
    ]);
    assert.match(refs, /refs\/heads\/room\/architecture/);

    // Orphan: the room branch must NOT carry main's content.
    const { stdout: tree } = await exec("git", [
      "-C",
      remote,
      "ls-tree",
      "-r",
      "--name-only",
      "room/architecture",
    ]);
    assert.doesNotMatch(tree, /\.komnet\/net\.yaml/, "a room branch must not carry the record");
  });

  it("delivers a message from one agent to another", async () => {
    const sent = await alice(
      "ask",
      "architecture",
      "Are refunds partial-capable?",
      "--needs",
      "human",
      "--mention",
      "bob-codex",
    );
    assert.equal(sent.code, 0, sent.stderr);

    assert.equal(
      (await bob("init", "--repo", remote, "--network", "acme", "--agent", "bob-codex")).code,
      0,
    );
    assert.equal((await bob("room", "join", "architecture")).code, 0);

    const sync = parseJson<{ delivered: number; recorded: number; anomalies: unknown[] }>(
      await bob("sync", "--json"),
    );
    assert.equal(sync.recorded, 1);
    assert.equal(sync.delivered, 1);
    assert.deepEqual(sync.anomalies, []);

    const inbox = parseJson<{ id: string; needs: string; from: string }[]>(
      await bob("inbox", "--json"),
    );
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]?.from, "alice-cursor");
    assert.equal(inbox[0]?.needs, "human");
  });

  it("refuses needs:human on the ordinary agent path", async () => {
    const inbox = parseJson<{ id: string }[]>(await bob("inbox", "--json"));
    const id = inbox[0]?.id as string;

    const refused = await bob("answer", id, "Partial is fine.");
    assert.equal(refused.code, 1, "the ordinary path must require the explicit relay flow");
    assert.match(refused.stderr, /direct agent path will not answer it/);

    // And it stays pending — a refusal must not silently consume the item.
    const still = parseJson<unknown[]>(await bob("inbox", "--json"));
    assert.equal(still.length, 1);
  });

  it("refuses --as-human without a terminal as a best-effort workflow check", async () => {
    // This avoids accidental non-interactive attribution. It is deliberately
    // not treated as proof that a person, rather than an agent, controls the TTY.
    const inbox = parseJson<{ id: string }[]>(await bob("inbox", "--json"));
    const id = inbox[0]?.id as string;

    const scripted = await bob("answer", id, "Partial is fine.", "--as-human");
    assert.equal(scripted.code, 1);
    assert.match(scripted.stderr, /interactive terminal/);

    // And it stays pending — a refusal must not consume the item.
    assert.equal(parseJson<unknown[]>(await bob("inbox", "--json")).length, 1);
  });

  it("records a confirmed relay with declared human attribution", async () => {
    // Drive the cooperative relay confirmation directly.
    const { Network, Layout, loadConfig, resolveNetwork } = await import("@komnet/core");
    const layout = new Layout(bobHome);
    const config = (await loadConfig(layout.configPath)) as NonNullable<
      Awaited<ReturnType<typeof loadConfig>>
    >;
    const network = Network.open(layout, resolveNetwork(config), config.agent);
    try {
      const pending = network.inbox({ needs: "human" })[0];
      assert.ok(pending, "expected a pending human decision");
      const answered = await network.answer(pending.id, "Partial-capable from day one.", {
        confirmHuman: async () => true,
      });
      assert.equal(answered.header.authorKind, "human");
    } finally {
      network.close();
    }

    assert.equal(
      parseJson<unknown[]>(await bob("inbox", "--json")).length,
      0,
      "answering clears it",
    );

    assert.equal((await alice("sync")).code, 0);
    const messages = parseJson<{ authorKind: string; kind: string }[]>(
      await alice("read", "architecture", "--json"),
    );
    const answer = messages.find((m) => m.kind === "answer");
    assert.ok(answer, "the answer must come back to the asker");
    assert.equal(answer.authorKind, "human", "a human decision must stay attributed to the human");
  });

  it("threads the answer under the question", async () => {
    const messages = parseJson<
      { id: string; kind: string; thread: string; inReplyTo: string | null }[]
    >(await alice("read", "architecture", "--json"));
    const question = messages.find((m) => m.kind === "question");
    const answer = messages.find((m) => m.kind === "answer");
    assert.ok(question && answer);
    assert.equal(answer.inReplyTo, question.id);
    assert.equal(answer.thread, question.thread);
    assert.ok(
      messages.indexOf(question) < messages.indexOf(answer),
      "reply must follow its parent",
    );
  });

  it("blocks a send containing a credential", async () => {
    const blocked = await alice("send", "architecture", "the key is AKIAIOSFODNN7EXAMPLE");
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /aws-access-key-id/);
    assert.doesNotMatch(blocked.stderr, /AKIAIOSFODNN7EXAMPLE/, "must not echo the secret back");
  });

  it("allows an explicit override, and records the reason permanently", async () => {
    const forced = await alice(
      "send",
      "architecture",
      "the key is AKIAIOSFODNN7EXAMPLE",
      "--force-unsafe",
      "documented rotation example, not a live key",
      "--json",
    );
    const { id } = parseJson<{ id: string }>(forced);

    await bob("sync");
    const { stdout: tree } = await exec("git", [
      "-C",
      remote,
      "ls-tree",
      "-r",
      "--name-only",
      "room/architecture",
    ]);

    // Select by id, never by sort order. Message filenames are
    // `<YYYYMMDD>T<HHMMSS>Z-<agent-id>-<ulid-tail>.md`: whole seconds, then
    // agent id. Two messages sent in the same second therefore sort by author,
    // not by send order, so "lexically last" is not "most recent" — with
    // `alice-cursor` and `bob-codex` in one second, the newer alice message
    // sorts first and a `.sort().pop()` silently reads bob's file instead.
    // The ULID tail is read back off the filename so this needs no knowledge of
    // its length.
    const path = tree
      .split("\n")
      .filter((p) => p.includes("/msg/"))
      .find((p) => id.endsWith(p.slice(p.lastIndexOf("-") + 1).replace(/\.md$/, "")));
    assert.ok(path, `no message file found for ${id}`);

    const { stdout: content } = await exec("git", [
      "-C",
      remote,
      "show",
      `room/architecture:${path}`,
    ]);
    assert.match(content, /unsafe_reason: documented rotation example/);
    // Guards the selection itself: under the old sort-and-pop this could pass
    // on a different agent's message that happened to sort last.
    assert.match(content, /^from: alice-cursor$/m);
    assert.match(content, new RegExp(`^id: ${id}$`, "m"));
  });

  it("reports status and a healthy doctor", async () => {
    const status = parseJson<{
      agentId: string;
      subscriptions: string[];
      lastSyncAt: string | null;
    }>(await alice("status", "--json"));
    assert.equal(status.agentId, "alice-cursor");
    assert.deepEqual(status.subscriptions, ["architecture"]);
    assert.ok(status.lastSyncAt !== null);

    const doctor = await alice("doctor");
    assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
    assert.match(doctor.stdout, /no problems found/);
  });

  it("lists both agents from their published cards", async () => {
    const agents = parseJson<{ id: string }[]>(await alice("agents", "--json"));
    assert.deepEqual(agents.map((a) => a.id).sort(), ["alice-cursor", "bob-codex"]);
  });

  it("configures repository resolution only from machine-local paths", async () => {
    const mapped = parseJson<{ id: string; path: string }>(
      await bob("repo", "map", "github.com/acme/payments", product, "--json"),
    );
    assert.equal(mapped.id, "github.com/acme/payments");
    assert.equal(mapped.path, await realpath(product));

    const listed = parseJson<{
      repositories: { id: string; path: string; fetchRemote?: string }[];
      review: { maxPreparedWorktrees: number };
    }>(await bob("repo", "list", "--json"));
    assert.deepEqual(listed.repositories, [
      { id: "github.com/acme/payments", path: await realpath(product) },
    ]);
    assert.equal(listed.review.maxPreparedWorktrees, 1);

    const policy = parseJson<{ maxPreparedWorktrees: number }>(
      await bob("repo", "policy", "--max-prepared", "2", "--json"),
    );
    assert.equal(policy.maxPreparedWorktrees, 2);
  });

  it("runs a guarded repository review lifecycle", async () => {
    const requested = parseJson<{
      review: { id: string; state: string; repo: string; reviewer: string };
      needs: string;
    }>(
      await alice(
        "review",
        "request",
        "architecture",
        "Review refund idempotency",
        "--reviewer",
        "bob-codex",
        "--repo",
        "github.com/acme/payments",
        "--base",
        productBaseRev,
        "--head",
        productHeadRev,
        "--scope",
        "src/refunds",
        "--json",
      ),
    );
    assert.equal(requested.needs, "agent");
    assert.equal(requested.review.state, "requested");
    assert.equal(requested.review.reviewer, "bob-codex");

    await bob("sync");
    const reviews = parseJson<{ review: { id: string; state: string } }[]>(
      await bob("review", "list", "architecture", "--json"),
    );
    assert.ok(reviews.some((task) => task.review.id === requested.review.id));

    const prepared = parseJson<{
      checkoutPath: string;
      headRev: string;
      relation: string;
      reused: boolean;
    }>(await bob("review", "prepare", "architecture", requested.review.id, "--json"));
    assert.equal(prepared.headRev, productHeadRev);
    assert.equal(prepared.relation, "base-is-ancestor");
    assert.equal(prepared.reused, false);
    assert.equal(
      await readFile(join(prepared.checkoutPath, "src", "refunds", "service.ts"), "utf8"),
      "export const retryOwner = 'ledger';\n",
    );
    assert.equal(
      (await exec("git", ["-C", prepared.checkoutPath, "rev-parse", "HEAD"])).stdout.trim(),
      productHeadRev,
    );

    const reported = parseJson<{ review: { state: string }; needs: string; refs: string[] }>(
      await bob(
        "review",
        "update",
        "architecture",
        requested.review.id,
        "reported",
        "One finding needs requester context.",
        "--ref",
        `github.com/acme/payments@${productHeadRev}:src/refunds/service.ts:84`,
        "--json",
      ),
    );
    assert.equal(reported.review.state, "reported");
    assert.equal(reported.needs, "agent");
    assert.equal(reported.refs.length, 1);

    await alice("sync");
    const completed = parseJson<{ review: { state: string }; needs: string }>(
      await alice(
        "review",
        "update",
        "architecture",
        requested.review.id,
        "completed",
        "Finding resolved after checking the caller.",
        "--json",
      ),
    );
    assert.equal(completed.review.state, "completed");
    assert.equal(completed.needs, "none");

    const released = parseJson<{ released: boolean }>(
      await bob("review", "release", requested.review.id, "--json"),
    );
    assert.equal(released.released, true);
    await assert.rejects(() => access(prepared.checkoutPath));
  });

  it("writes the inbox as plain markdown for agents with no integration", async () => {
    await alice("sync");
    await alice("inbox");
    const dir = join(aliceHome, "inbox", "alice-cursor");
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir);
    assert.ok(files.length > 0, "inbox must be readable with nothing but `cat`");
    const body = await readFile(join(dir, files[0] as string), "utf8");
    assert.match(body, /- needs:/);
  });

  it("searches the live window of subscribed rooms", async () => {
    assert.equal((await alice("send", "architecture", "the refund ledger is idempotent")).code, 0);
    await alice("sync");

    const hits = parseJson<{ room: string; body: string }[]>(
      await alice("search", "idempotent", "--json"),
    );
    assert.ok(hits.length >= 1, "expected a match");
    assert.equal(hits[0]?.room, "architecture");
    assert.match(hits[0]?.body ?? "", /idempotent/);

    const none = parseJson<unknown[]>(await alice("search", "zzz-no-such-token", "--json"));
    assert.deepEqual(none, []);
  });

  it("reads past the live window from git history", async () => {
    const history = parseJson<{ id: string; kind: string }[]>(
      await alice("history", "architecture", "--json"),
    );
    const live = parseJson<{ id: string }[]>(await alice("read", "architecture", "--json"));
    assert.ok(history.length >= live.length, "history must cover at least the live window");

    // Resolved through `git log --diff-filter=A` + the adding commit, so this
    // keeps working after a seal removes messages from the tree.
    const ids = new Set(history.map((m) => m.id));
    for (const m of live) assert.ok(ids.has(m.id), `history is missing live message ${m.id}`);
  });

  it("converges when both agents send before either syncs", async () => {
    const a = await alice("send", "architecture", "concurrent from alice", "--json");
    const b = await bob("send", "architecture", "concurrent from bob", "--json");
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);

    await alice("sync");
    const messages = parseJson<{ body: string }[]>(await alice("read", "architecture", "--json"));
    const bodies = messages.map((m) => m.body).join("\n");
    assert.match(bodies, /concurrent from alice/);
    assert.match(bodies, /concurrent from bob/, "neither send may clobber the other");
  });
});

/**
 * The whole point of `handshake` is that one command replaces the sequence a
 * person used to drive by hand, so it is asserted through the built binary in
 * both directions rather than against `Network` in-process.
 */
describe("komnet CLI, first contact", () => {
  interface HandshakeJson {
    room: string;
    thread: string;
    role: string;
    addressed: string[];
    presencePublished: boolean;
    synced: boolean;
    peers: { id: string; status: string }[];
    message: { id: string; tags: string[]; needs: string };
    watch: string;
  }

  let opened: string;
  let thread: string;

  it("announces, greets, and hands back the exact command to watch", async () => {
    const result = parseJson<HandshakeJson>(
      await alice("handshake", "architecture", "checking the link", "--json"),
    );
    opened = result.message.id;
    thread = result.thread;

    assert.equal(result.role, "open");
    assert.equal(result.room, "architecture");
    assert.equal(result.synced, true);
    assert.deepEqual(result.message.tags, ["handshake"]);
    assert.equal(result.message.needs, "agent");
    assert.deepEqual(result.addressed, ["@room"]);
    assert.equal(result.watch, `komnet watch --thread ${thread}`);
    assert.ok(
      result.peers.some((peer) => peer.id === "bob-codex"),
      "the report must name who could answer",
    );

    const presence = parseJson<{ id: string; status: string }[]>(await alice("presence", "--json"));
    assert.equal(presence.find((row) => row.id === "alice-cursor")?.status, "live");
  });

  it("surfaces the greeting to the peer as a tagged, filterable item", async () => {
    assert.equal((await bob("sync")).code, 0);

    const tagged = parseJson<{ id: string; tags: string[] }[]>(
      await bob("inbox", "--json", "--tag", "handshake"),
    );
    assert.deepEqual(
      tagged.map((row) => row.id),
      [opened],
    );
    assert.deepEqual(tagged[0]?.tags, ["handshake"]);
  });

  it("emits one metadata-only line per item, and never a body", async () => {
    const watched = await bob("watch", "--once", "--tag", "handshake");
    assert.equal(watched.code, 0, watched.stderr);

    const lines = watched.stdout.trim().split("\n");
    assert.match(lines[0] ?? "", /^watch-armed /, "the armed line is the proof the loop is live");
    const event = lines.find((line) => line.startsWith("komnet-inbox "));
    assert.ok(event !== undefined, "a pending handshake must produce an event line");
    assert.match(event, new RegExp(`id=${opened}\\b`));
    assert.match(event, /from=alice-cursor\b/);
    assert.match(event, /tags=handshake\b/);

    // The rule this whole event format exists for: every line becomes a
    // notification in a live session, so remote text must never ride along.
    assert.doesNotMatch(watched.stdout, /checking the link/, "an event line must carry no body");
    for (const line of lines) assert.ok(line.length < 400, `event line too long: ${line}`);
  });

  it("acks back into the same thread and clears the item", async () => {
    const ack = parseJson<HandshakeJson>(await bob("handshake", "ack", opened, "--json"));
    assert.equal(ack.role, "ack");
    assert.equal(ack.thread, thread, "an ack must join the thread the opener is watching");
    assert.deepEqual(ack.message.tags, ["handshake-ack"]);
    assert.deepEqual(ack.addressed, ["alice-cursor"]);

    const remaining = parseJson<{ id: string }[]>(
      await bob("inbox", "--json", "--tag", "handshake"),
    );
    assert.deepEqual(remaining, [], "an acked handshake must stop being announced");
  });

  it("delivers the ack to the thread the opener was watching", async () => {
    assert.equal((await alice("sync")).code, 0);

    const watched = await alice("watch", "--once", "--thread", thread);
    assert.equal(watched.code, 0, watched.stderr);
    const event = watched.stdout.split("\n").find((line) => line.startsWith("komnet-inbox "));
    assert.ok(event !== undefined, "the reply must reach the watcher armed on this thread");
    assert.match(event, /from=bob-codex\b/);
    assert.match(event, /tags=handshake-ack\b/);
    assert.match(event, new RegExp(`thread=${thread}\\b`));
  });

  it("emits nothing for a thread with no traffic, rather than everything", async () => {
    const watched = await alice("watch", "--once", "--thread", "01ZZZZZZZZZZZZZZZZZZZZZZZZ");
    assert.equal(watched.code, 0, watched.stderr);
    assert.equal(
      watched.stdout.split("\n").filter((line) => line.startsWith("komnet-inbox ")).length,
      0,
    );
  });

  it("blocks on --wait and returns as soon as a match arrives", async () => {
    // The failure this covers is not a crash: an agent turn cannot spin, so
    // with no blocking primitive the only options were to burn turns polling or
    // hand back to the human. Both ends are asserted — the wait must end when
    // something lands, and must give up with a distinguishable code when it
    // does not.
    const waiting = bob("watch", "--wait", "60", "--interval", "2");
    const sent = await alice(
      "send",
      "architecture",
      "arriving while bob waits",
      "--mention",
      "bob-codex",
    );
    assert.equal(sent.code, 0, sent.stderr);

    const result = await waiting;
    assert.equal(result.code, 0, `expected the wait to be satisfied: ${result.stderr}`);
    const event = result.stdout.split("\n").find((line) => line.startsWith("komnet-inbox "));
    assert.ok(event !== undefined, "the wait must report what satisfied it");
    assert.match(event, /from=alice-cursor\b/);
    assert.doesNotMatch(result.stdout, /arriving while bob waits/, "still metadata only");
  });

  it("exits 3 on a wait that times out, distinct from a failure", async () => {
    const result = await bob("watch", "--wait", "3", "--interval", "2", "--tag", "no-such-tag");
    assert.equal(result.code, 3, result.stderr);
    assert.match(result.stdout, /watch-timeout after=3s/);
    assert.equal(result.stdout.split("\n").filter((l) => l.startsWith("komnet-inbox ")).length, 0);
  });

  it("refuses to ack anything that is not an open handshake", async () => {
    const sent = parseJson<{ id: string }>(
      await alice("send", "architecture", "ordinary message", "--mention", "bob-codex", "--json"),
    );
    assert.equal((await bob("sync")).code, 0);

    const refused = await bob("handshake", "ack", sent.id);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /is not an open handshake/);
  });

  it("declares presence away without sending anything", async () => {
    const result = await bob("presence", "--away", "--json");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(parseJson<{ status: string }>(result).status, "away");

    const presence = parseJson<{ id: string; status: string }[]>(await bob("presence", "--json"));
    assert.equal(presence.find((row) => row.id === "bob-codex")?.status, "away");
  });

  it("rejects --live and --away together instead of picking one", async () => {
    const result = await bob("presence", "--live", "--away");
    assert.equal(result.code, 2);
    assert.match(result.stderr, /pick one/);
  });
});

/**
 * Two agents on ONE machine, over a local transport.
 *
 * This is the ordinary case — Claude and Codex side by side, or two sessions of
 * one tool — and it used to fail silently. A machine had a single agent id, so
 * both tools were the same participant, and routing never returns a message to
 * its own author: everything they sent each other was dropped with no error,
 * and `komnet answer` reported the message was not in the inbox.
 */
describe("komnet CLI, several agents on one machine", () => {
  let root: string;
  let localRemote: string;
  let claudeHome: string;
  let codexHome: string;

  const at = (home: string, ...args: string[]) => komnet(home, ...args);

  before(async () => {
    root = join(tmp, "machine");
    localRemote = join(tmp, "local-transport.git");
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", localRemote]);

    for (const id of ["komdosh-claude", "komdosh-codex"]) {
      const result = await komnet(
        root,
        "agent",
        "add",
        id,
        "--repo",
        localRemote,
        "--network",
        "l",
      );
      assert.equal(result.code, 0, result.stderr);
    }
    claudeHome = (await komnet(root, "agent", "path", "komdosh-claude")).stdout.trim();
    codexHome = (await komnet(root, "agent", "path", "komdosh-codex")).stdout.trim();
  });

  it("provisions distinct identities, each with its own home", async () => {
    const rows = parseJson<{ id: string; home: string; network: string | null }[]>(
      await komnet(root, "agent", "list", "--json"),
    );
    assert.deepEqual(
      rows.map((r) => r.id),
      ["komdosh-claude", "komdosh-codex"],
    );
    assert.notEqual(claudeHome, codexHome, "two agents must never share a home");
    for (const row of rows) assert.equal(row.network, "l");
  });

  it("refuses to reuse an id rather than silently sharing an identity", async () => {
    const clash = await komnet(root, "agent", "add", "komdosh-codex", "--repo", localRemote);
    assert.equal(clash.code, 1);
    assert.match(clash.stderr, /already exists/);
  });

  it("carries a question, an answer, and a decision between them", async () => {
    assert.equal((await at(claudeHome, "room", "create", "general")).code, 0);
    assert.equal((await at(codexHome, "room", "join", "general")).code, 0);

    const asked = parseJson<{ id: string }>(
      await at(
        claudeHome,
        "send",
        "general",
        "who takes feed?",
        "--mention",
        "komdosh-codex",
        "--needs",
        "agent",
        "--json",
      ),
    );

    assert.equal((await at(codexHome, "sync")).code, 0);
    const inbox = parseJson<{ id: string; from: string }[]>(await at(codexHome, "inbox", "--json"));
    assert.deepEqual(
      inbox.map((i) => i.id),
      [asked.id],
      "a peer on the same machine must actually receive the message",
    );
    assert.equal(inbox[0]?.from, "komdosh-claude");

    // The call that failed under a shared identity, with the message present in
    // nobody's inbox because the sender and recipient were one agent.
    const answered = await at(codexHome, "answer", asked.id, "I will.");
    assert.equal(answered.code, 0, answered.stderr);

    const decided = await at(codexHome, "decide", "general", "Feed owner", "codex owns feed.");
    assert.equal(decided.code, 0, decided.stderr);

    assert.equal((await at(claudeHome, "sync")).code, 0);
    const window = parseJson<{ from: string; kind: string }[]>(
      await at(claudeHome, "read", "general", "--json"),
    );
    assert.deepEqual(
      window.map((m) => `${m.from}:${m.kind}`),
      ["komdosh-claude:msg", "komdosh-codex:answer", "komdosh-codex:decision"],
    );
  });

  it("pins a tool to one agent's home so it cannot inherit the shared identity", async () => {
    // Run in a scratch project: `setup cursor` writes relative to the working
    // directory, and a test must not drop a config into the repository.
    const project = join(tmp, "pinned-project");
    await mkdir(project, { recursive: true });
    await exec(process.execPath, [CLI, "setup", "cursor", "--agent", "komdosh-codex"], {
      env: { ...process.env, KOMNET_HOME: root, NO_COLOR: "1" },
      cwd: project,
    });

    const written = JSON.parse(await readFile(join(project, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers?: { komnet?: { env?: { KOMNET_HOME?: string } } };
    };
    assert.equal(
      written.mcpServers?.komnet?.env?.KOMNET_HOME,
      codexHome,
      "the tool config must carry the agent's home, or the tool has no identity of its own",
    );
  });

  it("refuses to pin a tool to an agent that does not exist", async () => {
    const result = await komnet(root, "setup", "cursor", "--agent", "never-provisioned");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no agent 'never-provisioned'/);
  });
});

describe("komnet CLI, argument handling", () => {
  it("exits quietly when its output is closed early", async () => {
    // `komnet read <room> | head` is ordinary usage; an unhandled EPIPE would
    // print a stack trace over whatever the user was reading.
    const { stdout } = await exec(
      "sh",
      [
        "-c",
        `KOMNET_HOME='${aliceHome}' '${process.execPath}' '${CLI}' read architecture | head -2`,
      ],
      { env: { ...process.env, NO_COLOR: "1" } },
    );
    assert.doesNotMatch(stdout, /EPIPE|Unhandled/, "a closed pipe must not produce a stack trace");
  });

  it("reports its version", async () => {
    const result = await komnet(aliceHome, "--version");
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^\d+\.\d+\.\d+/);
  });

  it("exits 2 with usage on no command", async () => {
    const result = await komnet(aliceHome);
    assert.equal(result.code, 2);
    assert.match(result.stdout, /USAGE/);
  });

  it("exits 2 on an unknown command", async () => {
    const result = await komnet(aliceHome, "frobnicate");
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unknown command/);
  });

  it("exits 2 on an unknown flag", async () => {
    const result = await komnet(aliceHome, "status", "--nonsense");
    assert.equal(result.code, 2);
  });

  it("rejects an unsafe room id before touching the filesystem", async () => {
    const result = await komnet(aliceHome, "read", "../etc/passwd");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /invalid room id/);
  });
});
