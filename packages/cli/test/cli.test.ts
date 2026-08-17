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

/**
 * Peek the inbox.
 *
 * `komnet inbox --json` returns `{ health, items }` — health travels with every
 * read so an empty list can never be mistaken for a quiet network.
 */
async function inboxOf(
  run: (...args: string[]) => Promise<Result>,
  ...extra: string[]
): Promise<{ health: { degraded: boolean }; items: Record<string, unknown>[] }> {
  const result = await run("inbox", "--json", ...extra);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as {
    health: { degraded: boolean };
    items: Record<string, unknown>[];
  };
}

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

    const inbox = (await inboxOf(bob)).items as { id: string; needs: string; from: string }[];
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]?.from, "alice-cursor");
    assert.equal(inbox[0]?.needs, "human");
  });

  it("refuses needs:human on the ordinary agent path", async () => {
    const inbox = (await inboxOf(bob)).items as { id: string }[];
    const id = inbox[0]?.id as string;

    const refused = await bob("answer", id, "Partial is fine.");
    assert.equal(refused.code, 1, "the ordinary path must require the explicit relay flow");
    assert.match(refused.stderr, /direct agent path will not answer it/);

    // And it stays pending — a refusal must not silently consume the item.
    const still = (await inboxOf(bob)).items;
    assert.equal(still.length, 1);
  });

  it("refuses --as-human without a terminal as a best-effort workflow check", async () => {
    // This avoids accidental non-interactive attribution. It is deliberately
    // not treated as proof that a person, rather than an agent, controls the TTY.
    const inbox = (await inboxOf(bob)).items as { id: string }[];
    const id = inbox[0]?.id as string;

    const scripted = await bob("answer", id, "Partial is fine.", "--as-human");
    assert.equal(scripted.code, 1);
    assert.match(scripted.stderr, /interactive terminal/);

    // And it stays pending — a refusal must not consume the item.
    assert.equal((await inboxOf(bob)).items.length, 1);
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

    assert.equal((await inboxOf(bob)).items.length, 0, "answering clears it");

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

  it("publishes and reads a concise agent profile", async () => {
    const updated = parseJson<{
      published: boolean;
      profile: { id: string; role: string; currentFocus: string; canHelpWith: string[] };
    }>(
      await bob(
        "profile",
        "update",
        "--role",
        "Repository review engineer",
        "--mission",
        "Help the team merge correct changes.",
        "--focus",
        "Reviewing payment code.",
        "--workspace",
        "github.com/acme/payments",
        "--capability",
        "Inspect exact Git revisions",
        "--responsibility",
        "Report concrete correctness findings",
        "--constraint",
        "Cannot make product policy decisions",
        "--help-with",
        "Repository reviews",
        "--json",
      ),
    );
    assert.equal(updated.published, true);
    assert.equal(updated.profile.role, "Repository review engineer");
    assert.deepEqual(updated.profile.canHelpWith, ["Repository reviews"]);

    await alice("sync");
    const shown = parseJson<{ id: string; role: string; currentFocus: string }>(
      await alice("profile", "bob-codex", "--json"),
    );
    assert.equal(shown.id, "bob-codex");
    assert.equal(shown.role, "Repository review engineer");
    assert.equal(shown.currentFocus, "Reviewing payment code.");

    const agents = parseJson<{ id: string; role?: string }[]>(await alice("agents", "--json"));
    assert.equal(
      agents.find((agent) => agent.id === "bob-codex")?.role,
      "Repository review engineer",
    );
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

  it("creates, refines, claims, and completes a shared task", async () => {
    const created = parseJson<{
      task: { id: string; state: string; target: string | null };
      needs: string;
      mentions: string[];
    }>(
      await alice(
        "task",
        "create",
        "architecture",
        "Implement append-only task messages.",
        "--title",
        "Task protocol",
        "--stale-after",
        "3600",
        "--json",
      ),
    );
    assert.equal(created.task.state, "open");
    assert.equal(created.needs, "agent");
    assert.deepEqual(created.mentions, ["@room"]);

    await bob("sync");
    const refined = parseJson<{ task: { state: string; title: string } }>(
      await bob(
        "task",
        "update",
        "architecture",
        created.task.id,
        "refined",
        "Implement protocol fields, reducers, CLI, MCP, and sealing protection.",
        "--title",
        "Task protocol end to end",
        "--json",
      ),
    );
    assert.equal(refined.task.state, "open");
    assert.equal(refined.task.title, "Task protocol end to end");

    // alice created it, so by default this machine's policy stops bob taking it
    // on until a person here agrees. This is the ordinary path a user walks.
    const refused = await bob(
      "task",
      "claim",
      "architecture",
      created.task.id,
      "Taking the protocol and lifecycle slice first.",
    );
    // Exit 4 is the machine-readable half; the instructions go to stderr so an
    // agent piping --json still gets clean stdout.
    assert.equal(refused.code, 4, refused.stderr);
    assert.match(refused.stderr, /needs a person's approval/i);
    assert.match(refused.stderr, /komnet task approve architecture/);

    assert.equal((await bob("task", "approve", "architecture", created.task.id)).code, 0);
    const claimed = parseJson<{ task: { state: string; assignee: string }; mentions: string[] }>(
      await bob(
        "task",
        "claim",
        "architecture",
        created.task.id,
        "Taking the protocol and lifecycle slice first.",
        "--json",
      ),
    );
    assert.equal(claimed.task.state, "claimed");
    assert.equal(claimed.task.assignee, "bob-codex");
    assert.ok(claimed.mentions.includes("@room"));

    await bob(
      "task",
      "update",
      "architecture",
      created.task.id,
      "started",
      "Implementation started.",
    );
    const completed = parseJson<{ task: { state: string }; needs: string }>(
      await bob(
        "task",
        "update",
        "architecture",
        created.task.id,
        "completed",
        "Implementation and tests are green.",
        "--json",
      ),
    );
    assert.equal(completed.task.state, "completed");
    assert.equal(completed.needs, "none");

    await alice("sync");
    const tasks = parseJson<
      {
        task: { id: string; state: string; assignee: string };
        definition: string;
        stale: boolean;
      }[]
    >(await alice("task", "list", "architecture", "--json"));
    const status = tasks.find((task) => task.task.id === created.task.id);
    assert.equal(status?.task.state, "completed");
    assert.equal(status?.task.assignee, "bob-codex");
    assert.match(status?.definition ?? "", /reducers, CLI, MCP/);
    assert.equal(status?.stale, false);
  });

  it("reconstructs one task in full, so work can be resumed by another session", async () => {
    const created = parseJson<{ task: { id: string } }>(
      await alice(
        "task",
        "create",
        "architecture",
        "Split the sealer into resumable stages.",
        "--title",
        "Resumable sealing",
        "--target",
        "bob-codex",
        "--json",
      ),
    );
    const taskId = created.task.id;

    await bob("sync");
    assert.equal((await bob("task", "approve", "architecture", taskId, "go ahead")).code, 0);
    await bob("task", "claim", "architecture", taskId, "Taking it; reading the sealer first.");
    await bob("task", "update", "architecture", taskId, "started", "Mapped the four stages.");
    await bob(
      "task",
      "update",
      "architecture",
      taskId,
      "progressed",
      "Stage one lands the lock; the transaction file survives a crash.",
      "--ref",
      "komnet@abc1234:packages/core/src/seal/sealer.ts",
    );

    await alice("sync");
    const detail = parseJson<{
      task: { id: string; state: string; assignee: string };
      definition: string;
      participants: string[];
      events: { action: string; from: string; body: string; refs: string[] }[];
    }>(await alice("task", "show", "architecture", taskId, "--json"));

    assert.equal(detail.task.state, "in_progress");
    assert.equal(detail.task.assignee, "bob-codex");
    assert.deepEqual(
      detail.events.map((event) => event.action),
      ["created", "claimed", "started", "progressed"],
    );
    // The evidence is what a resuming agent cannot reconstruct from the state.
    const progressed = detail.events[3];
    assert.match(progressed?.body ?? "", /survives a crash/);
    assert.deepEqual(progressed?.refs, ["komnet@abc1234:packages/core/src/seal/sealer.ts"]);
    assert.deepEqual(detail.participants, ["alice-cursor", "bob-codex"]);

    // And the agenda answers "what am I on the hook for" without naming a room.
    const agenda = parseJson<{
      entries: { room: string; relation: string; status: { task: { id: string } } }[];
      counts: { assigned: number; created: number };
    }>(await bob("task", "agenda", "--json"));
    const entry = agenda.entries.find((candidate) => candidate.status.task.id === taskId);
    assert.equal(entry?.relation, "assigned");
    assert.equal(entry?.room, "architecture");

    const forCreator = parseJson<{
      entries: { relation: string; status: { task: { id: string } } }[];
    }>(await alice("task", "agenda", "--json"));
    assert.equal(
      forCreator.entries.find((candidate) => candidate.status.task.id === taskId)?.relation,
      "created",
      "the creator still carries the task, because chasing it is theirs",
    );
  });

  it("leads the session-start brief with work in hand, then the mail", async () => {
    // Bob is mid-way through "Resumable sealing" from the previous case, and
    // now a teammate writes to him about something else.
    assert.equal(
      (
        await alice(
          "send",
          "architecture",
          "unrelated: staging is rebuilt tomorrow",
          "--mention",
          "bob-codex",
        )
      ).code,
      0,
    );
    await bob("sync");

    const brief = await bob("inbox", "--brief");
    assert.equal(brief.code, 0, brief.stderr);

    const work = brief.stdout.indexOf("in flight");
    const mail = brief.stdout.indexOf("pending message(s)");
    assert.ok(work >= 0, `expected work in hand in the brief:\n${brief.stdout}`);
    assert.ok(mail >= 0, `expected pending mail in the brief:\n${brief.stdout}`);
    assert.ok(
      work < mail,
      "this is the one unasked push there is, so it must anchor the session on its own unfinished work rather than on another agent's",
    );
    assert.match(brief.stdout, /Resumable sealing/);
    // The last thing recorded is what stops the work being started over.
    assert.match(brief.stdout, /last progressed: .*survives a crash/);

    // And the cheap check separates the two without quoting anybody.
    const status = parseJson<{
      attention: { interrupting: { reason: string }[]; deferred: number };
      tasks: { inFlight: number };
    }>(await bob("status", "--json"));
    assert.equal(status.tasks.inFlight, 1);
    assert.equal(
      status.attention.interrupting.length + status.attention.deferred,
      parseJson<{ items: unknown[] }>(await bob("inbox", "--json")).items.length,
      "every pending item is either worth stopping for or explicitly not",
    );
  });

  it("reads and scaffolds policy on a machine that has joined no network", async () => {
    // Setting the rules before joining anything is a reasonable first move, so
    // none of this may depend on a configured network — or on the home existing.
    const fresh = join(tmp, "unconfigured");
    const run = (...args: string[]) => komnet(fresh, ...args);

    const before = await run("policy");
    assert.equal(before.code, 0, before.stderr);
    assert.match(before.stdout, /inboundWork\s+remote/);
    assert.match(before.stdout, /no policy file is present/);

    assert.equal((await run("policy", "--init")).code, 0);
    const after = await run("policy", "--json");
    assert.equal(after.code, 0, after.stderr);
    const parsed = JSON.parse(after.stdout) as {
      policy: { approvals: { inboundWork: string } };
      sources: string[];
    };
    assert.equal(parsed.policy.approvals.inboundWork, "remote");
    assert.equal(parsed.sources.length, 1);

    // Never clobber a file a person owns.
    const again = await run("policy", "--init");
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already exists/);

    // A bad value names the file rather than failing somewhere deep.
    await writeFile(join(fresh, "policy.yaml"), "approvals:\n  inboundWork: sometimes\n", "utf8");
    const broken = await run("policy");
    assert.equal(broken.code, 1);
    assert.match(broken.stderr, /must be one of: never, remote, always/);
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
 * The flow an agent actually writes: a shell loop that checks the inbox.
 *
 * It is asserted here rather than against `Network` because everything that
 * broke it lived between the command and the engine — no daemon means no
 * puller, so reads answered from a cache nothing was filling, and the sender
 * was told its correctly-spelled peer did not exist. Both looked like "mentions
 * are broken" from either end.
 */
interface TraceJson {
  id: string;
  pushed: boolean;
  recipients: { agent: string; routable: string; read: boolean; answered: boolean }[];
}

describe("komnet CLI, polling without a daemon", () => {
  let pollRemote: string;
  let danaHome: string;
  let erinHome: string;
  let dana: (...args: string[]) => Promise<Result>;
  let erin: (...args: string[]) => Promise<Result>;

  before(async () => {
    pollRemote = join(tmp, "polling.git");
    danaHome = join(tmp, "dana");
    erinHome = join(tmp, "erin");
    dana = (...args: string[]) => komnet(danaHome, ...args);
    erin = (...args: string[]) => komnet(erinHome, ...args);
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", pollRemote]);

    assert.equal(
      (await dana("init", "--repo", pollRemote, "--network", "poll", "--agent", "dana-cursor"))
        .code,
      0,
    );
    assert.equal((await dana("room", "create", "delivery")).code, 0);
    assert.equal(
      (await erin("init", "--repo", pollRemote, "--network", "poll", "--agent", "erin-codex")).code,
      0,
    );
    assert.equal((await erin("room", "join", "delivery")).code, 0);
  });

  it("shows a mentioned agent its message without being told to sync", async () => {
    // The reported failure: an agent writes `while :; do komnet inbox; sleep
    // 30; done`, is mentioned, and reads "inbox empty" forever. Delivery is
    // pull-based and nothing was pulling — with no daemon, only `komnet sync`
    // was, which is the step the loop existed to avoid. An empty inbox has to
    // mean an empty inbox.
    assert.equal(
      (
        await dana(
          "send",
          "delivery",
          "erin, can you take the retry path?",
          "--mention",
          "erin-codex",
        )
      ).code,
      0,
    );

    const inbox = (await inboxOf(erin)).items as { from: string; body: string }[];
    assert.equal(inbox.length, 1, "one poll of the inbox must be enough to see it");
    assert.equal(inbox[0]?.from, "dana-cursor");
  });

  it("does not tell a sender that a registered peer is unknown", async () => {
    // The false alarm that made mentions look guilty: the forecast reads this
    // machine's last-fetched roster, so a peer who registered after the last
    // sync came back as "no agent card — check the id is spelled right" about a
    // correctly-spelled id whose message was about to arrive perfectly well.
    const sent = await dana("send", "delivery", "second one", "--mention", "erin-codex");
    assert.equal(sent.code, 0, sent.stderr);
    assert.doesNotMatch(sent.stderr, /spelled/);
    assert.doesNotMatch(sent.stderr, /erin-codex/, "a peer that follows the room needs no warning");
  });

  it("names the real problem when a mention will not be delivered", async () => {
    // The case a mention genuinely cannot reach: routing delivers only within
    // the recipient's subscriptions, so this must be said plainly at send time
    // rather than discovered a day later as silence.
    const frankHome = join(tmp, "frank");
    assert.equal(
      (
        await komnet(
          frankHome,
          "init",
          "--repo",
          pollRemote,
          "--network",
          "poll",
          "--agent",
          "frank-claude",
        )
      ).code,
      0,
    );

    const sent = await dana("send", "delivery", "frank?", "--mention", "frank-claude");
    assert.equal(sent.code, 0, sent.stderr);
    assert.match(sent.stderr, /frank-claude does not follow #delivery/);
    assert.match(sent.stderr, /komnet room join delivery/);

    // And the mention really is invisible to him until he joins — which is why
    // `komnet mentions` exists to find it.
    assert.equal((await inboxOf(komnet.bind(null, frankHome))).items.length, 0);
    const found = parseJson<{ room: string; from: string }[]>(
      await komnet(frankHome, "mentions", "--json"),
    );
    assert.equal(found.length, 1, "an unjoined room is where a lost mention hides");
    assert.equal(found[0]?.room, "delivery");
  });

  it("marks backlog as pending, and only wakes on arrivals with --new-only", async () => {
    // The reported failure: `watch --wait 900` fired three times on the same
    // message, because "block until one match arrives" matched anything in the
    // inbox — including items pending since before the watcher started. The
    // agent relayed "a message arrived" to its user and had to retract it.
    const pending = await erin("watch", "--once");
    assert.equal(pending.code, 0, pending.stderr);
    assert.match(
      pending.stdout,
      /komnet-inbox state=pending/,
      "an item that was already sitting there is backlog, not news",
    );

    // Nothing new since; --new-only must therefore time out rather than
    // re-announce the backlog as an arrival.
    const quiet = await erin("watch", "--wait", "3", "--interval", "2", "--new-only");
    assert.equal(quiet.code, 3, "exit 3 is 'checked, and nothing came'");
    assert.match(quiet.stdout, /checked=confirmed/, "silence is only reportable when confirmed");
  });

  it("says so when it could not check, instead of reporting silence", async () => {
    // A watcher that cannot reach the remote knows nothing about the room. The
    // old code reported the same "nothing matched" either way, and an agent
    // acts on a false negative exactly as it would on the truth.
    //
    // The wait has to clear the announcement, and the earliest that can arrive
    // is arithmetic rather than luck: `watch-degraded` waits for THREE
    // consecutive failures, and `--interval` is floored at
    // WATCH_MIN_INTERVAL_S = 2, so the third poll cannot start before ~4s.
    // This used to ask for it inside 3s, which put the third poll exactly on
    // the deadline — it then passed or failed on how loaded the machine was,
    // and it failed for real during a full-suite run. Measured here: the line
    // lands at ~5s. Do not trim the wait back without also moving the
    // threshold in `main.ts` or that floor.
    const gone = `${pollRemote}.hidden`;
    await exec("mv", [pollRemote, gone]);
    try {
      const blind = await komnet(
        join(tmp, "frank"),
        "watch",
        "--wait",
        "8",
        "--interval",
        "2",
        "--new-only",
      );
      assert.equal(blind.code, 4, "exit 4 is 'could NOT check' — never confused with quiet");
      assert.match(blind.stdout, /checked=UNCONFIRMED/);
      assert.match(
        blind.stdout,
        /watch-degraded/,
        "and it says so while running, not only at the end",
      );
    } finally {
      await exec("mv", [gone, pollRemote]);
    }
  });

  it("names the network and identity it is actually watching", async () => {
    // "The daemon reported the default network while the conversation was in
    // another one" — a watcher on the wrong network reports the right answer
    // about the wrong place, and that is indistinguishable from a quiet room.
    const armed = await erin("watch", "--once");
    assert.match(armed.stdout, /watch-armed .*network=poll/);
    assert.match(armed.stdout, /agent=erin-codex/);
  });

  it("tells a waiting agent about rooms and conversations it is not part of", async () => {
    // The gap: an agent joins one room and waits. Routing keeps every other
    // room out of its inbox — correctly — and a conversation started beside it
    // was addressed to somebody else, so nothing ever says either happened.
    // Waiting is then indistinguishable from there being nothing to know.
    assert.equal((await dana("room", "create", "release-1-0")).code, 0);
    assert.equal(
      (
        await dana(
          "send",
          "delivery",
          "frank, can you take the migration?",
          "--mention",
          "frank-claude",
        )
      ).code,
      0,
    );

    const watching = await erin("watch", "--once");
    assert.equal(watching.code, 0, watching.stderr);
    assert.match(
      watching.stdout,
      /komnet-room id=release-1-0 state=not-joined join=komnet room join release-1-0/,
      "a room the team started is news, and the line says how to join it",
    );
    assert.match(
      watching.stdout,
      /komnet-thread state=started room=delivery .*from=dana-cursor.*addressed-to=other/,
      "so is a conversation opened next to this agent",
    );
    assert.doesNotMatch(
      watching.stdout,
      /migration/,
      "metadata only — a body must never arrive on a line the agent did not ask for",
    );

    // Same on the cheap check an agent already makes.
    const status = await erin("status");
    assert.match(status.stdout, /elsewhere .*release-1-0/);
    assert.match(status.stdout, /conversation\(s\) started without you/);

    // And it is awareness, not delivery: the inbox stays exactly as routing
    // decided, which is the invariant this must not quietly widen.
    const inbox = (await inboxOf(erin)).items as { room: string }[];
    assert.ok(
      inbox.every((item) => item.room === "delivery"),
      "an unjoined room must not start filling this agent's inbox",
    );
  });

  it("traces one message from stored to answered, per recipient", async () => {
    // "Sent" answered the narrowest question there is — this machine wrote a
    // commit — so an unread message and an ignored one looked identical, and a
    // mention that could never arrive looked like both.
    const sent = await dana(
      "send",
      "delivery",
      "does the retry limit stay at 10?",
      "--mention",
      "erin-codex",
      "--mention",
      "frank-claude",
    );
    assert.equal(sent.code, 0, sent.stderr);
    const id = /([0-9A-HJKMNP-TV-Z]{26})/.exec(sent.stdout)?.[1] as string;

    const before = parseJson<TraceJson>(await dana("trace", id, "--json"));
    assert.equal(before.pushed, true);
    const erinBefore = before.recipients.find((r) => r.agent === "erin-codex");
    assert.equal(erinBefore?.routable, "yes");
    assert.equal(erinBefore?.read, false, "nobody has drained it yet");
    assert.equal(
      before.recipients.find((r) => r.agent === "frank-claude")?.routable,
      "no",
      "an addressee who never joined the room is the one state a sender must not wait on",
    );

    // A receipt is what turns "pushed" into "somebody's agent processed it".
    assert.equal((await erin("inbox", "--drain")).code, 0);
    const read = parseJson<TraceJson>(await dana("trace", id, "--json"));
    assert.equal(read.recipients.find((r) => r.agent === "erin-codex")?.read, true);
    assert.equal(read.recipients.find((r) => r.agent === "erin-codex")?.answered, false);

    // And a reply in-thread is the strongest evidence available.
    assert.equal(
      (
        await erin(
          "send",
          "delivery",
          "no, it moved to 30",
          "--mention",
          "dana-cursor",
          "--reply-to",
          id,
        )
      ).code,
      0,
    );
    const answered = parseJson<TraceJson>(await dana("trace", id, "--json"));
    assert.equal(answered.recipients.find((r) => r.agent === "erin-codex")?.answered, true);
  });

  it("does not re-list the backlog to a watcher that asked for arrivals", async () => {
    // Reported: "existing pending messages keep appearing during --new-only".
    // They did — printed, then refused as a match, which is the worst of both:
    // the agent re-read them and could not tell why the wait had not ended.
    assert.equal(
      (await dana("send", "delivery", "one for the backlog", "--mention", "erin-codex")).code,
      0,
    );
    assert.equal((await erin("sync")).code, 0, "it has to be pending before the watcher arms");

    const quiet = await erin("watch", "--wait", "3", "--interval", "2", "--new-only");
    assert.equal(quiet.code, 3);
    assert.doesNotMatch(quiet.stdout, /komnet-inbox state=pending/);
    assert.match(quiet.stdout, /watch-backlog pending=\d+/, "said once, as a number");
  });

  it("reads and switches across several transport repos", async () => {
    // One agent, two networks. Both were always possible in the config and the
    // daemon always polled both — but a bare command meant whichever one the
    // config named, reading the other meant `--network` on every invocation,
    // and switching meant hand-editing YAML. So people ran one network per
    // machine and reopened editors to move between them.
    const second = join(tmp, "second.git");
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", second]);
    assert.equal(
      (await erin("init", "--repo", second, "--network", "sideline")).code,
      0,
      "a second network is added, not switched to",
    );
    assert.equal((await erin("room", "create", "aside", "--network", "sideline")).code, 0);

    const listed = parseJson<{ id: string; current: boolean; subscriptions: string[] }[]>(
      await erin("network", "list", "--json"),
    );
    assert.deepEqual(
      listed.map((net) => net.id).sort(),
      ["poll", "sideline"],
      "both networks are listed",
    );
    assert.equal(listed.find((net) => net.current)?.id, "poll", "adding one must not switch");
    assert.deepEqual(listed.find((net) => net.id === "sideline")?.subscriptions, ["aside"]);

    // A peer writes on the second network only. Its own home is fresh, so this
    // does not depend on which network an earlier test left it pointed at.
    const ginaHome = join(tmp, "gina");
    assert.equal(
      (
        await komnet(
          ginaHome,
          "init",
          "--repo",
          second,
          "--network",
          "sideline",
          "--agent",
          "gina-cursor",
        )
      ).code,
      0,
    );
    assert.equal((await komnet(ginaHome, "room", "join", "aside")).code, 0);
    assert.equal(
      (await komnet(ginaHome, "send", "aside", "over here instead", "--mention", "erin-codex"))
        .code,
      0,
    );

    // The bound network is right to say nothing; the agent should not have to
    // know which repo the answer will arrive on to find it.
    // Earlier cases left their own mail pending here, so the claim is about
    // this message specifically: the bound network never carries it.
    const bound = (await inboxOf(erin)).items as { room: string }[];
    assert.ok(
      bound.every((item) => item.room !== "aside"),
      "a message sent on another network must not appear on this one",
    );
    const everywhere = await erin("inbox", "--all-networks", "--json");
    assert.equal(everywhere.code, 0, everywhere.stderr);
    const merged = JSON.parse(everywhere.stdout) as {
      networks: { network: string; items: { room: string }[] }[];
    };
    const aside = merged.networks.find((section) => section.network === "sideline");
    assert.equal(aside?.items.length, 1, "reading every network finds it");
    assert.equal(aside?.items[0]?.room, "aside");

    // And switching is a command, not a config edit — the next bare read follows.
    assert.equal((await erin("network", "use", "sideline")).code, 0);
    assert.equal((await inboxOf(erin)).items.length, 1, "a bare command follows the switch");
    assert.equal((await erin("network", "use", "poll")).code, 0);
  });

  it("reports a message the remote refused as queued, not as a failure", async () => {
    // The field report this is from: `komnet ask` printed raw git plumbing —
    // `push --quiet origin room/general:room/general failed (128): Permission
    // denied (publickey)` — for a message that was committed, safe, and did go
    // out on the next sync. A sender who believes that error sends again, and
    // the duplicate is permanent in a log nobody can edit.
    const gone = `${pollRemote}.moved`;
    await exec("mv", [pollRemote, gone]);
    let sent: Result;
    try {
      sent = await dana(
        "send",
        "delivery",
        "written while the remote was gone",
        "--mention",
        "erin-codex",
      );
    } finally {
      await exec("mv", [gone, pollRemote]);
    }

    assert.equal(sent.code, 0, "a durable message is not a failed command");
    assert.match(sent.stdout, /queued/, "it must say which of the two states it reached");
    assert.match(sent.stdout, /komnet sync/, "and how to push it now");
    assert.match(sent.stdout, /do NOT send it again/i, "because the duplicate is what costs");
    assert.doesNotMatch(
      sent.stdout + sent.stderr,
      /protocol\.version|quotePath/,
      "komnet's own git flags are not news to the sender",
    );

    // And it really was safe: a later sync pushes it, exactly once.
    assert.equal((await dana("sync")).code, 0);
    const seen = (await inboxOf(erin)).items as { body: string }[];
    assert.equal(
      seen.filter((item) => item.body.includes("written while the remote was gone")).length,
      1,
    );
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

    const tagged = (await inboxOf(bob, "--tag", "handshake")).items as {
      id: string;
      tags: string[];
    }[];
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

    const remaining = (await inboxOf(bob, "--tag", "handshake")).items as { id: string }[];
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
    const inbox = (await inboxOf((...a: string[]) => at(codexHome, ...a))).items as {
      id: string;
      from: string;
    }[];
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

  it("refuses to write as a guessed identity when the machine holds several", async () => {
    // The incident this prevents: an agent shells out to `komnet` from a shell
    // that does not carry its KOMNET_HOME, and the message lands under whichever
    // identity the default home happens to hold. The correction has to be a
    // second message admitting the first was misattributed.
    const fakeHome = join(tmp, "guessed");
    const komnetDir = join(fakeHome, ".komnet");
    // The realistic shape: a configured shared identity AND per-agent homes.
    // A bare `komnet send` here resolves to the shared one — whoever that is.
    assert.equal(
      (
        await komnet(
          komnetDir,
          "init",
          "--repo",
          localRemote,
          "--network",
          "l",
          "--agent",
          "shared-cli",
        )
      ).code,
      0,
    );
    for (const id of ["alpha-claude", "beta-codex"]) {
      const added = await komnet(
        komnetDir,
        "agent",
        "add",
        id,
        "--repo",
        localRemote,
        "--network",
        "l",
      );
      assert.equal(added.code, 0, added.stderr);
    }

    // No KOMNET_HOME: the default home is a coin flip between two identities.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome, NO_COLOR: "1" };
    delete env["KOMNET_HOME"];
    delete env["KOMNET_AGENT"];
    const guessed = await exec(process.execPath, [CLI, "send", "general", "hello"], { env })
      .then(() => ({ code: 0, stderr: "" }))
      .catch((error: unknown) => {
        const e = error as { code?: number; stderr?: string };
        return { code: e.code ?? 1, stderr: e.stderr ?? "" };
      });
    assert.equal(guessed.code, 6, "a guessed identity is its own outcome, not a generic failure");
    assert.match(guessed.stderr, /alpha-claude, beta-codex/, "it must name who it could have been");
    assert.match(guessed.stderr, /shared-cli/, "and who it would silently have become");
    assert.match(guessed.stderr, /--agent/);

    // Reading is NOT gated: a confusing inbox can be corrected by looking again,
    // whereas a misattributed message is permanent.
    const read = await exec(process.execPath, [CLI, "status"], { env })
      .then(() => 0)
      .catch(() => 1);
    assert.equal(read, 0, "reads must stay usable; only permanent writes are gated");
  });

  it("acts as the asserted identity, and refuses when it cannot", async () => {
    // --agent both SELECTS that agent's home and ASSERTS the result, so it can
    // never silently resolve to somebody else.
    const sent = await komnet(root, "--agent", "komdosh-codex", "send", "general", "from codex");
    assert.equal(sent.code, 0, sent.stderr);

    const read = parseJson<{ agentId: string }>(
      await komnet(root, "--agent", "komdosh-codex", "status", "--json"),
    );
    assert.equal(read.agentId, "komdosh-codex", "the assertion selected the right home");

    // Asserting an identity this home does not hold must fail, not fall back.
    const wrong = await komnet(claudeHome, "--agent", "komdosh-codex", "send", "general", "nope");
    assert.equal(wrong.code, 6);
    assert.match(wrong.stderr, /refusing to act as komdosh-claude when komdosh-codex was asserted/);
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

  it("repairs an existing Codex MCP entry when an agent identity is pinned", async () => {
    const fakeUserHome = join(tmp, "codex-user-home");
    const configPath = join(fakeUserHome, ".codex", "config.toml");
    await mkdir(join(fakeUserHome, ".codex"), { recursive: true });
    await writeFile(
      configPath,
      '[mcp_servers.komnet]\ncommand = "komnet"\nargs = ["mcp"]\nstartup_timeout_sec = 20\n\n[projects."/work/kept"]\ntrust_level = "trusted"\n',
      "utf8",
    );

    const runSetup = async (): Promise<Result> => {
      try {
        const { stdout, stderr } = await exec(
          process.execPath,
          [CLI, "setup", "codex", "--agent", "komdosh-codex"],
          {
            env: {
              ...process.env,
              HOME: fakeUserHome,
              KOMNET_HOME: root,
              NO_COLOR: "1",
            },
          },
        );
        return { code: 0, stdout, stderr };
      } catch (error) {
        const result = error as { code?: number; stdout?: string; stderr?: string };
        return {
          code: result.code ?? 1,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
      }
    };

    const repaired = await runSetup();
    assert.equal(repaired.code, 0, repaired.stderr);
    assert.match(repaired.stdout, /identity.*\(updated\)/);
    const config = await readFile(configPath, "utf8");
    assert.match(
      config,
      new RegExp(
        `env = \\{ KOMNET_HOME = ${JSON.stringify(codexHome).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\}`,
      ),
    );
    assert.match(config, /startup_timeout_sec = 20/, "user-owned MCP settings must survive");
    assert.match(config, /\[projects\."\/work\/kept"\]/, "unrelated TOML must survive");

    const repeated = await runSetup();
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.match(repeated.stdout, /unchanged/);
    assert.equal(await readFile(configPath, "utf8"), config, "setup must be idempotent");
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
