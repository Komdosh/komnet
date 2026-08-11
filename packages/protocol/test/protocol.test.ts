import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicalForm,
  compareMessages,
  createMessage,
  decisionPath,
  digestPath,
  groupByThread,
  isAddressedTo,
  isMessagePath,
  isRoomId,
  isUlid,
  mayModify,
  messageFilename,
  messagePath,
  parseMessage,
  parseMessagePath,
  roomIdFromRef,
  roomRef,
  sealTransactionPath,
  serializeMessage,
  slugify,
  threadOrder,
  ulid,
  ulidTime,
  UnsupportedVersionError,
  MalformedMessageError,
} from "../src/index.ts";
import type { Message } from "../src/index.ts";

const sample = (over: Partial<Parameters<typeof createMessage>[0]> = {}): Message =>
  createMessage({
    id: "01J8XR7K9MQ4Z2N8P0VWXYZABC".slice(0, 26),
    room: "architecture",
    from: "komdosh-claude",
    authorKind: "agent",
    kind: "question",
    needs: "human",
    ts: "2026-08-11T14:22:33.412Z",
    body: "Are refunds partial-capable?\n",
    ...over,
  });

describe("ulid", () => {
  it("mints 26-char identifiers that round-trip their timestamp", () => {
    const at = Date.UTC(2026, 7, 11, 14, 22, 33);
    const id = ulid(at);
    assert.equal(id.length, 26);
    assert.ok(isUlid(id));
    assert.equal(ulidTime(id), at);
  });

  it("sorts chronologically as plain strings", () => {
    const ids = [ulid(1000), ulid(2000), ulid(3000)];
    assert.deepEqual([...ids].sort(), ids);
  });

  it("stays strictly increasing within one millisecond", () => {
    const ids = Array.from({ length: 200 }, () => ulid(5_000));
    const sorted = [...ids].sort();
    assert.deepEqual(sorted, ids, "same-ms ULIDs must remain monotonic");
    assert.equal(new Set(ids).size, ids.length, "must not collide");
  });

  it("does not regress when the clock steps backwards", () => {
    const first = ulid(9_000);
    const second = ulid(8_000); // NTP step / VM resume
    assert.ok(second > first, "a backwards clock must not reorder messages");
  });

  it("excludes ambiguous Crockford characters", () => {
    const ids = Array.from({ length: 50 }, () => ulid()).join("");
    assert.doesNotMatch(ids, /[ILOU]/);
  });
});

describe("identifiers", () => {
  it("accepts conventional ids and rejects unsafe ones", () => {
    assert.ok(isRoomId("architecture"));
    assert.ok(isRoomId("checkout-refunds"));
    assert.ok(!isRoomId("Architecture"), "uppercase collides on case-insensitive filesystems");
    assert.ok(!isRoomId("-leading"));
    assert.ok(!isRoomId("trailing-"));
    assert.ok(!isRoomId("has/slash"), "slashes would break the room/<id> ref namespace");
    assert.ok(!isRoomId("main"), "reserved");
  });

  it("slugifies free text and refuses to invent a name", () => {
    assert.equal(slugify("API Design"), "api-design");
    assert.equal(slugify("  Checkout / Refunds  "), "checkout-refunds");
    assert.equal(slugify("!!!"), null);
  });
});

describe("message round-trip", () => {
  it("serialises and parses back identically", () => {
    const original = sample();
    const parsed = parseMessage(serializeMessage(original));
    assert.deepEqual(parsed.header, original.header);
    assert.equal(parsed.body, original.body);
  });

  it("is byte-stable across repeated serialisation", () => {
    const once = serializeMessage(sample());
    const twice = serializeMessage(parseMessage(once));
    assert.equal(twice, once, "re-serialising must not produce a spurious diff");
  });

  it("preserves unknown header fields verbatim (ADR 0007)", () => {
    const raw = [
      "---",
      "v: 1",
      "id: 01J8XR7K9MQ4Z2N8P0VWXYZABC",
      "room: architecture",
      "from: komdosh-claude",
      "author_kind: agent",
      "ts: 2026-08-11T14:22:33.412Z",
      "kind: msg",
      "thread: 01J8XR7K9MQ4Z2N8P0VWXYZABC",
      "needs: none",
      "future_field: from-a-newer-peer",
      "---",
      "body",
      "",
    ].join("\n");

    const parsed = parseMessage(raw);
    assert.equal(parsed.header.extra["future_field"], "from-a-newer-peer");
    assert.match(
      serializeMessage(parsed),
      /future_field: from-a-newer-peer/,
      "a seal by an older node must not strip a newer node's fields",
    );
  });

  it("surfaces an unsupported version instead of dropping the message", () => {
    const raw = serializeMessage(sample()).replace("v: 1", "v: 99");
    assert.throws(() => parseMessage(raw), UnsupportedVersionError);
  });

  it("rejects malformed frontmatter", () => {
    assert.throws(() => parseMessage("no frontmatter here"), MalformedMessageError);
    assert.throws(() => parseMessage("---\nv: 1\nunterminated"), MalformedMessageError);
    assert.throws(
      () => parseMessage(serializeMessage(sample()).replace("needs: human", "needs: maybe")),
      MalformedMessageError,
    );
    assert.throws(
      () => parseMessage(serializeMessage(sample()).replace("room: architecture", "room: MAIN")),
      MalformedMessageError,
    );
  });

  it("tolerates CRLF line endings", () => {
    const crlf = serializeMessage(sample()).replace(/\n/g, "\r\n");
    assert.equal(parseMessage(crlf).header.id, sample().header.id);
  });

  it("omits the signature from the canonical signing form", () => {
    const signed = sample();
    signed.header.sig = "SIGNATURE";
    assert.doesNotMatch(canonicalForm(signed), /SIGNATURE/);
    assert.match(canonicalForm(signed), /Are refunds partial-capable\?/);
  });
});

describe("paths", () => {
  it("builds a sortable, human-legible message path", () => {
    const header = sample().header;
    assert.equal(messageFilename(header), "20260811T142233Z-komdosh-claude-P0VWXYZABC.md");
    assert.equal(
      messagePath(header),
      "rooms/architecture/msg/2026/08/11/20260811T142233Z-komdosh-claude-P0VWXYZABC.md",
    );
  });

  it("round-trips through parseMessagePath", () => {
    const path = messagePath(sample().header);
    const parsed = parseMessagePath(path);
    assert.ok(parsed);
    assert.equal(parsed.room, "architecture");
    assert.equal(parsed.agentId, "komdosh-claude");
    assert.ok(isMessagePath(path));
    assert.equal(parseMessagePath("rooms/architecture/room.yaml"), null);
  });

  it("maps rooms to refs and back", () => {
    assert.equal(roomRef("architecture"), "room/architecture");
    assert.equal(roomIdFromRef("refs/heads/room/architecture"), "architecture");
    assert.equal(roomIdFromRef("refs/heads/main"), null);
  });

  it("zero-pads decision sequences so they sort", () => {
    assert.equal(
      decisionPath("architecture", 7, "event-envelope"),
      "rooms/architecture/decisions/0007-event-envelope.md",
    );
    assert.throws(() => decisionPath("architecture", 0, "x"), TypeError);
  });

  it("builds deterministic batch digest and seal transaction paths", () => {
    assert.equal(
      digestPath("architecture", "2026-08", "0123456789abcdef"),
      "rooms/architecture/digest/2026-08-0123456789abcdef.md",
    );
    assert.equal(sealTransactionPath("architecture"), "rooms/architecture/.seal/transaction.json");
    assert.throws(() => digestPath("architecture", "2026-8", "0123456789abcdef"), TypeError);
    assert.throws(() => digestPath("architecture", "2026-08", "not-a-seal-id"), TypeError);
  });

  it("permits modification only of an agent's own files (ADR 0004)", () => {
    assert.ok(mayModify("agents/komdosh-claude.yaml", "komdosh-claude"));
    assert.ok(mayModify("rooms/architecture/receipts/komdosh-claude.json", "komdosh-claude"));
    assert.ok(!mayModify("agents/alice-cursor.yaml", "komdosh-claude"));
    assert.ok(!mayModify("rooms/architecture/receipts/alice-cursor.json", "komdosh-claude"));
    assert.ok(!mayModify(messagePath(sample().header), "komdosh-claude"), "messages are immutable");
  });
});

describe("routing", () => {
  const subscribed = new Set(["architecture"]);

  it("delivers direct mentions", () => {
    const m = sample({ mentions: ["alice-cursor"] });
    assert.ok(isAddressedTo(m.header, "alice-cursor", subscribed));
    assert.ok(!isAddressedTo(m.header, "bob-codex", subscribed));
  });

  it("delivers @room only to subscribers", () => {
    const m = sample({ mentions: ["@room"] });
    assert.ok(isAddressedTo(m.header, "alice-cursor", subscribed));
    assert.ok(!isAddressedTo(m.header, "alice-cursor", new Set()));
  });

  it("never routes a message back to its author", () => {
    const m = sample({ mentions: ["@room", "komdosh-claude"] });
    assert.ok(!isAddressedTo(m.header, "komdosh-claude", subscribed));
  });
});

describe("ordering", () => {
  const root = sample({ id: ulid(1_000), kind: "question" });
  const replyA = createMessage({
    id: ulid(2_000),
    room: "architecture",
    from: "alice-cursor",
    authorKind: "agent",
    kind: "answer",
    needs: "none",
    thread: root.header.id,
    inReplyTo: root.header.id,
    body: "first",
  });
  const replyB = createMessage({
    id: ulid(3_000),
    room: "architecture",
    from: "bob-codex",
    authorKind: "agent",
    kind: "answer",
    needs: "none",
    thread: root.header.id,
    inReplyTo: root.header.id,
    body: "second",
  });

  it("places replies after their parent regardless of input order", () => {
    const ordered = threadOrder([replyB, root, replyA]);
    assert.deepEqual(
      ordered.map((m) => m.header.id),
      [root.header.id, replyA.header.id, replyB.header.id],
    );
  });

  it("treats an orphaned reply as a root rather than dropping it", () => {
    const ordered = threadOrder([replyA]);
    assert.equal(ordered.length, 1, "a partial window must still render");
  });

  it("survives a deep thread without stack overflow", () => {
    const chain: Message[] = [root];
    for (let i = 0; i < 20_000; i++) {
      const prev = chain[chain.length - 1] as Message;
      chain.push(
        createMessage({
          id: ulid(10_000 + i),
          room: "architecture",
          from: "alice-cursor",
          authorKind: "agent",
          kind: "msg",
          needs: "none",
          thread: root.header.id,
          inReplyTo: prev.header.id,
          body: `d${String(i)}`,
        }),
      );
    }
    assert.equal(threadOrder(chain).length, chain.length);
  });

  it("groups by thread", () => {
    const other = sample({ id: ulid(9_000) });
    const groups = groupByThread([root, replyA, other]);
    assert.equal(groups.size, 2);
    assert.equal(groups.get(root.header.id)?.length, 2);
  });

  it("orders by ULID, not wall clock", () => {
    const early = sample({ id: ulid(1_000), ts: "2030-01-01T00:00:00.000Z" });
    const late = sample({ id: ulid(2_000), ts: "2020-01-01T00:00:00.000Z" });
    assert.ok(compareMessages(early.header, late.header) < 0, "a skewed clock must not reorder");
  });
});
