import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyAttention, type AttentionInput } from "../src/attention.ts";

function item(overrides: Partial<AttentionInput> & { id: string }): AttentionInput {
  return {
    room: "payments",
    from: "alice-codex",
    needs: "agent",
    priority: "normal",
    thread: "01THREAD-OTHER",
    ...overrides,
  };
}

describe("attention", () => {
  const inFlight = new Set(["01THREAD-MINE"]);

  it("selects a reply on the work in hand and defers ordinary chatter", () => {
    const result = classifyAttention(
      [item({ id: "01A", thread: "01THREAD-MINE" }), item({ id: "01B" }), item({ id: "01C" })],
      inFlight,
    );

    assert.deepEqual(
      result.interrupting.map((i) => [i.id, i.reason]),
      [["01A", "in-flight-thread"]],
    );
    assert.equal(result.deferred, 2);
  });

  it("selects work only a person can clear, and work its sender is blocked on", () => {
    const result = classifyAttention(
      [
        item({ id: "01A", needs: "human" }),
        item({ id: "01B", priority: "blocking" }),
        item({ id: "01C", needs: "none" }),
      ],
      inFlight,
    );

    assert.deepEqual(
      result.interrupting.map((i) => [i.id, i.reason]),
      [
        ["01A", "needs-human"],
        ["01B", "blocking"],
      ],
    );
    assert.equal(result.deferred, 1);
  });

  it("describes an interruption by the work it touches before the priority it claims", () => {
    const result = classifyAttention(
      [item({ id: "01A", thread: "01THREAD-MINE", needs: "human", priority: "blocking" })],
      inFlight,
    );
    assert.equal(result.interrupting[0]?.reason, "in-flight-thread");
  });

  it("carries no message body, which is the whole point of the call", () => {
    // The caller passes inbox rows, and an inbox row carries the message. If a
    // body reaches the reader here then checking is once again the context
    // switch it was meant to let them avoid.
    const row = {
      ...item({ id: "01A", thread: "01THREAD-MINE" }),
      body: "secret plans",
      path: "p",
    };
    const result = classifyAttention([row], inFlight);

    assert.equal(result.interrupting.length, 1);
    assert.deepEqual(Object.keys(result.interrupting[0] as object).sort(), [
      "from",
      "id",
      "needs",
      "priority",
      "reason",
      "room",
      "thread",
    ]);
  });

  it("defers everything when nothing is in flight but a human is still needed", () => {
    const result = classifyAttention(
      [item({ id: "01A", thread: "01THREAD-MINE" }), item({ id: "01B", needs: "human" })],
      new Set(),
    );
    assert.deepEqual(
      result.interrupting.map((i) => [i.id, i.reason]),
      [["01B", "needs-human"]],
    );
    assert.equal(result.deferred, 1);
  });
});
