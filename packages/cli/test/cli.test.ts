import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
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
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
});

after(async () => {
  await rm(tmp, { recursive: true, force: true });
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
    assert.equal(forced.code, 0, forced.stderr);

    await bob("sync");
    const { stdout: tree } = await exec("git", [
      "-C",
      remote,
      "ls-tree",
      "-r",
      "--name-only",
      "room/architecture",
    ]);
    const path = tree
      .split("\n")
      .filter((p) => p.includes("/msg/"))
      .sort()
      .pop() as string;
    const { stdout: content } = await exec("git", [
      "-C",
      remote,
      "show",
      `room/architecture:${path}`,
    ]);
    assert.match(content, /unsafe_reason: documented rotation example/);
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
