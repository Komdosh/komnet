import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import {
  createMessage,
  createReviewTask,
  ulid,
  type Message,
  type ReviewTask,
} from "@komnet/protocol";

import { defaultIdentity } from "../src/config.ts";
import { Layout } from "../src/layout.ts";
import { Network } from "../src/network.ts";
import { reduceReviewTasks } from "../src/review/tasks.ts";

const exec = promisify(execFile);

function reviewEvent(
  from: string,
  review: ReviewTask,
  options: { inReplyTo?: string; thread?: string; kind?: "question" | "status" } = {},
): Message {
  const id = ulid();
  return createMessage({
    id,
    room: "reviews",
    from,
    authorKind: "agent",
    kind: options.kind ?? "status",
    thread: options.thread ?? id,
    needs:
      review.state === "needs_human"
        ? "human"
        : review.state === "requested" ||
            review.state === "reported" ||
            review.state === "discussing" ||
            review.state === "blocked"
          ? "agent"
          : "none",
    mentions: review.state === "requested" ? [review.reviewer] : [],
    ...(options.inReplyTo === undefined ? {} : { inReplyTo: options.inReplyTo }),
    body: `${review.state}\n`,
    review,
  });
}

process.env["GIT_AUTHOR_NAME"] = "komnet test";
process.env["GIT_AUTHOR_EMAIL"] = "test@komnet.invalid";
process.env["GIT_COMMITTER_NAME"] = "komnet test";
process.env["GIT_COMMITTER_EMAIL"] = "test@komnet.invalid";

describe("review task lifecycle integration", () => {
  let tmp: string;
  let alice: Network;
  let bob: Network;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "komnet-review-"));
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
    // Budget pinned here rather than inherited: this test asserts that a bounded
    // discussion ends in a hand-off, and the number of exchanges it writes is
    // the point — not whatever DEFAULT_ROOM_POLICY currently is.
    await alice.createRoom("reviews", { replyBudget: 6 });

    bob = (
      await Network.init({
        layout: new Layout(join(tmp, "bob")),
        networkId: "acme",
        remote,
        identity: defaultIdentity({ id: "bob-codex" }),
      })
    ).network;
    await bob.joinRoom("reviews");
  });

  after(async () => {
    alice.close();
    bob.close();
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("pins a targeted request and lets only lifecycle owners advance it", async () => {
    const request = await alice.requestReview("reviews", {
      reviewer: "bob-codex",
      repo: "github.com/acme/payments",
      baseRev: "1".repeat(40),
      headRev: "2".repeat(40),
      scope: ["src/refunds"],
      summary: "Review refund idempotency and failure handling.",
    });
    assert.equal(request.header.needs, "agent");
    assert.deepEqual(request.header.mentions, ["bob-codex"]);
    assert.equal(request.header.review?.state, "requested");

    await bob.sync();
    const taskId = request.header.review?.id as string;
    assert.equal((await bob.listReviewTasks("reviews"))[0]?.review.id, taskId);

    const report = await bob.updateReview("reviews", taskId, {
      state: "reported",
      body: "One possible idempotency race at src/refunds/service.ts:84.",
      refs: ["github.com/acme/payments@" + "2".repeat(40) + ":src/refunds/service.ts:84"],
    });
    assert.equal(report.header.needs, "agent");
    assert.deepEqual(report.header.mentions, ["alice-codex"]);
    assert.equal(report.header.refs.length, 1);

    await alice.sync();
    await alice.updateReview("reviews", taskId, {
      state: "discussing",
      body: "The caller serializes that path; does the retry enter elsewhere?",
    });
    await assert.rejects(
      () =>
        bob.updateReview("reviews", taskId, {
          state: "completed",
          body: "Reviewer must not close the requester's task.",
        }),
      /only review requester/,
    );

    const completed = await alice.updateReview("reviews", taskId, {
      state: "completed",
      body: "Accepted after checking the caller; no user decision is required.",
    });
    assert.equal(completed.header.needs, "none");
    assert.equal(completed.header.review?.state, "completed");
    assert.equal((await alice.listReviewTasks("reviews"))[0]?.review.state, "completed");
  });

  it("ends a bounded agent discussion with a cooperative human handoff", async () => {
    const request = await alice.requestReview("reviews", {
      reviewer: "bob-codex",
      repo: "github.com/acme/orders",
      baseRev: "3".repeat(40),
      headRev: "4".repeat(40),
      summary: "Review order reservation consistency.",
    });
    const taskId = request.header.review?.id as string;
    await bob.sync();

    await bob.updateReview("reviews", taskId, {
      state: "reported",
      body: "Reservation generation rollover needs an explicit policy.",
    });
    await alice.sync();
    await alice.updateReview("reviews", taskId, {
      state: "discussing",
      body: "Does the reservation expire before or after payment timeout?",
    });
    await bob.sync();
    await bob.updateReview("reviews", taskId, {
      state: "discussing",
      body: "After payment timeout; the caller owns cancellation.",
    });
    await alice.sync();
    await alice.updateReview("reviews", taskId, {
      state: "discussing",
      body: "Then a late authorization can race cancellation.",
    });
    await bob.sync();
    await bob.updateReview("reviews", taskId, {
      state: "discussing",
      body: "The webhook path checks the reservation generation.",
    });
    await alice.sync();
    await alice.updateReview("reviews", taskId, {
      state: "discussing",
      body: "That still leaves the generation rollover policy ambiguous.",
    });
    await bob.sync();
    const parked = await bob.updateReview("reviews", taskId, {
      state: "discussing",
      body: "We need the engineer to choose reject-late or compensate-late semantics.",
    });

    assert.equal(parked.header.needs, "human");
    assert.equal(parked.header.review?.state, "needs_human");
    assert.ok(parked.header.tags.includes("reply-budget"));
    assert.equal((await bob.listReviewTasks("reviews"))[0]?.review.state, "needs_human");
  });
});

describe("review task reduction", () => {
  it("keeps the deterministic valid chain despite malformed and concurrent siblings", () => {
    const requested = createReviewTask({
      id: ulid(),
      requester: "alice-codex",
      reviewer: "bob-codex",
      repo: "github.com/acme/payments",
      baseRev: "1".repeat(40),
      headRev: "2".repeat(40),
    });
    const malformed = reviewEvent("bob-codex", { ...requested, state: "discussing" });
    const root = reviewEvent("alice-codex", requested, { kind: "question" });
    const reported = reviewEvent(
      "bob-codex",
      { ...requested, state: "reported" },
      {
        thread: root.header.thread,
        inReplyTo: root.header.id,
      },
    );
    const losingSibling = reviewEvent(
      "bob-codex",
      { ...requested, state: "blocked" },
      {
        thread: root.header.thread,
        inReplyTo: root.header.id,
      },
    );
    const completed = reviewEvent(
      "alice-codex",
      { ...requested, state: "completed" },
      {
        thread: root.header.thread,
        inReplyTo: reported.header.id,
      },
    );

    const [status] = reduceReviewTasks([completed, losingSibling, root, malformed, reported]);
    assert.equal(status?.review.state, "completed");
    assert.equal(status?.currentMessageId, completed.header.id);
    assert.deepEqual(
      status?.invalidEvents.map((event) => event.messageId),
      [malformed.header.id, losingSibling.header.id],
    );
  });
});
