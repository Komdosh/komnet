import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import {
  assertMachineId,
  assertTaskTransition,
  createMessage,
  isMachineToken,
  machineFromToken,
  machineMention,
  machineRoomId,
  ulid,
  type Message,
} from "@komnet/protocol";

import { defaultIdentity, defaultMachineIdentity } from "../src/config.ts";
import {
  agentsOnMachine,
  cardFromIdentity,
  expandMachineMentions,
  parseAgentCard,
  serializeAgentCard,
} from "../src/agent/card.ts";
import { Layout } from "../src/layout.ts";
import { Network } from "../src/network.ts";
import { reduceTasks } from "../src/task/tasks.ts";
import { shouldDeliverMessage } from "../src/sync/routing.ts";

const exec = promisify(execFile);

process.env["GIT_AUTHOR_NAME"] = "komnet test";
process.env["GIT_AUTHOR_EMAIL"] = "test@komnet.invalid";
process.env["GIT_COMMITTER_NAME"] = "komnet test";
process.env["GIT_COMMITTER_EMAIL"] = "test@komnet.invalid";

const ROOM = "arch";

function identityOn(id: string, machine: string) {
  return defaultIdentity({ id, machine: defaultMachineIdentity({ id: machine, label: machine }) });
}

function message(from: string, mentions: string[]): Message {
  const id = ulid();
  return createMessage({
    id,
    room: ROOM,
    from,
    authorKind: "agent",
    kind: "question",
    needs: "agent",
    thread: id,
    body: "who owns checkout?",
    mentions,
  });
}

describe("machine identity", () => {
  it("derives a stable id from the hostname, dropping the network suffix", () => {
    // `komdosh-mbp.local` and `komdosh-mbp` are one computer. Without this the
    // machine would change identity when it moved between networks.
    assert.equal(defaultMachineIdentity({ label: "komdosh-mbp.local" }).id, "komdosh-mbp");
    assert.equal(defaultMachineIdentity({ label: "komdosh-mbp" }).id, "komdosh-mbp");
    assert.equal(defaultMachineIdentity({ label: "Komdosh MBP.lan" }).id, "komdosh-mbp");
  });

  it("keeps the raw hostname as a label so a person recognises their own box", () => {
    assert.equal(defaultMachineIdentity({ label: "Komdosh-MBP.local" }).label, "Komdosh-MBP.local");
  });

  it("gives every agent on one computer the same machine, without them agreeing on it", () => {
    // Each local agent has its own KOMNET_HOME, so nothing is shared between
    // them. Derivation is what makes them land in one group anyway.
    const claude = defaultIdentity({ id: "komdosh-claude" });
    const codex = defaultIdentity({ id: "komdosh-codex" });
    assert.equal(claude.machine.id, codex.machine.id);
    assert.notEqual(claude.id, codex.id);
  });

  it("parses machine tokens and refuses anything that is not one", () => {
    assert.equal(machineMention("komdosh-mbp"), "machine:komdosh-mbp");
    assert.equal(machineFromToken("machine:komdosh-mbp"), "komdosh-mbp");
    assert.equal(machineFromToken("komdosh-claude"), null, "an agent id is not a machine");
    assert.equal(machineFromToken("@room"), null);
    assert.equal(machineFromToken("machine:NOT VALID"), null, "never throws on wire data");
    assert.equal(isMachineToken("machine:x"), true);
  });

  it("derives a room name a machine id can legally take", () => {
    assert.equal(machineRoomId("komdosh-mbp"), "komdosh-mbp");
    // Room ids forbid `.` and `_`, which machine ids allow.
    assert.equal(machineRoomId("build_box.01"), "build-box-01");
    // A slug that collides with a reserved room name is prefixed, not refused.
    assert.equal(machineRoomId("main"), "machine-main");
  });

  it("refuses a machine id that could not be a path or a ref component", () => {
    assert.throws(() => assertMachineId("Machine With Spaces"));
    assert.throws(() => assertMachineId("-leading-dash"));
  });
});

describe("the machine on an agent card", () => {
  it("round-trips through the published card", () => {
    const card = cardFromIdentity(identityOn("komdosh-claude", "komdosh-mbp"));
    const parsed = parseAgentCard(serializeAgentCard(card));
    assert.deepEqual(parsed.machine, { id: "komdosh-mbp", label: "komdosh-mbp" });
  });

  it("leaves the machine ABSENT on a card that predates the field", () => {
    // Undefined must not become a group of one: an older client claimed nothing,
    // and inventing a machine for it would put it somewhere it never asked to be.
    const card = cardFromIdentity(identityOn("old-agent", "somewhere"));
    const yaml = serializeAgentCard(card)
      .split("\n")
      .filter((line) => !line.startsWith("machine:") && !line.startsWith("  id: somewhere"))
      .join("\n")
      .replace(/^ {2}label: somewhere\n/m, "");
    assert.equal(parseAgentCard(yaml).machine, undefined);
  });

  it("treats an unusable machine id as unknown rather than as a claim", () => {
    const yaml = serializeAgentCard(cardFromIdentity(identityOn("a-claude", "box"))).replace(
      "id: box",
      "id: NOT A MACHINE",
    );
    assert.equal(parseAgentCard(yaml).machine, undefined);
  });
});

describe("expanding a machine mention", () => {
  const cards = [
    cardFromIdentity(identityOn("komdosh-claude", "komdosh-mbp")),
    cardFromIdentity(identityOn("komdosh-codex", "komdosh-mbp")),
    cardFromIdentity(identityOn("bob-claude", "bob-mbp")),
  ];

  it("resolves the token to the agents on that machine AND keeps the token", () => {
    // Both halves are load-bearing: the ids make it work against peers that have
    // never heard of machine addressing, the token makes it work for an agent
    // the sender has not fetched yet.
    assert.deepEqual(expandMachineMentions(["machine:komdosh-mbp"], cards), [
      "machine:komdosh-mbp",
      "komdosh-claude",
      "komdosh-codex",
    ]);
  });

  it("leaves agent ids and @room untouched", () => {
    assert.deepEqual(expandMachineMentions(["bob-claude", "@room"], cards), [
      "bob-claude",
      "@room",
    ]);
  });

  it("names an agent once when it is mentioned both directly and via its machine", () => {
    assert.deepEqual(expandMachineMentions(["komdosh-claude", "machine:komdosh-mbp"], cards), [
      "komdosh-claude",
      "machine:komdosh-mbp",
      "komdosh-codex",
    ]);
  });

  it("resolves an unknown machine to nothing rather than inventing a recipient", () => {
    assert.deepEqual(expandMachineMentions(["machine:nobody"], cards), ["machine:nobody"]);
    assert.deepEqual(agentsOnMachine(cards, "nobody"), []);
  });
});

describe("routing a machine mention", () => {
  const subscribed = new Set([ROOM]);

  it("delivers to every agent on the named machine", () => {
    const asked = message("bob-claude", ["machine:komdosh-mbp"]);
    assert.ok(shouldDeliverMessage(asked, "komdosh-claude", subscribed, "komdosh-mbp"));
    assert.ok(shouldDeliverMessage(asked, "komdosh-codex", subscribed, "komdosh-mbp"));
  });

  it("does not deliver to an agent on a different machine", () => {
    const asked = message("bob-claude", ["machine:komdosh-mbp"]);
    assert.equal(shouldDeliverMessage(asked, "carol-claude", subscribed, "carol-mbp"), false);
  });

  it("never routes a machine mention back to its own author", () => {
    // The author is on the machine it addressed — a session asking its own peers.
    const asked = message("komdosh-claude", ["machine:komdosh-mbp"]);
    assert.equal(shouldDeliverMessage(asked, "komdosh-claude", subscribed, "komdosh-mbp"), false);
  });

  it("ignores the token entirely when the caller tracks no machine", () => {
    const asked = message("bob-claude", ["machine:komdosh-mbp"]);
    assert.equal(shouldDeliverMessage(asked, "komdosh-claude", subscribed), false);
  });
});

describe("reducing a machine-targeted claim", () => {
  const taskId = ulid();
  const base = {
    id: taskId,
    creator: "bob-claude",
    title: "Regenerate the fixtures",
    target: "machine:komdosh-mbp",
    staleAfterSeconds: 3600,
  } as const;

  const created = createMessage({
    id: ulid(),
    room: ROOM,
    from: "bob-claude",
    authorKind: "agent",
    kind: "question",
    needs: "agent",
    // The root must address its target, and for a machine target that IS the
    // machine token — this is the shape `createTask` produces.
    mentions: ["machine:komdosh-mbp"],
    body: "Whoever on that box is free.",
    task: { ...base, state: "open", action: "created" },
  });

  function claimEvent(
    from: string,
    task: NonNullable<Parameters<typeof createMessage>[0]["task"]>,
  ): Message {
    return createMessage({
      id: ulid(),
      room: ROOM,
      from,
      authorKind: "agent",
      kind: "status",
      needs: "none",
      thread: created.header.thread,
      inReplyTo: created.header.id,
      body: "Taking it.",
      task,
    });
  }

  it("accepts the claim from the event alone, with no local identity involved", () => {
    // The property this protects: every machine reduces the same log to the
    // same owner. A verdict that consulted the reader's own roster would let
    // one machine accept a claim its neighbour rejected — which is how two
    // agents end up both believing they own the work.
    const claimed = claimEvent("komdosh-codex", {
      ...base,
      state: "claimed",
      action: "claimed",
      assignee: "komdosh-codex",
      assigneeMachine: "komdosh-mbp",
    });
    const [status] = reduceTasks([created, claimed]);
    assert.equal(status?.task.assignee, "komdosh-codex");
    assert.deepEqual(status?.invalidEvents, []);
  });

  it("rejects a claim stamped with a machine the task was not aimed at", () => {
    // Refused when the event is built, and identically when one arrives off the
    // wire: a snapshot whose own fields contradict each other never becomes a
    // task state on any machine.
    assert.throws(
      () =>
        claimEvent("bob-claude", {
          ...base,
          state: "claimed",
          action: "claimed",
          assignee: "bob-claude",
          assigneeMachine: "bob-mbp",
        }),
      /task_assignee_machine must be the machine named by task_target/,
    );
  });

  it("does not let machine addressing become a takeover route for agent-targeted work", () => {
    // The trap: a target that names no machine and a claimer that names no
    // machine are both "no machine", and comparing those two reads as a match.
    // That would make every agent-targeted task claimable by anyone.
    //
    // Asserted against the transition guard directly, because that is where the
    // comparison lives — the snapshot-shape check happens to refuse this event
    // first, and a later change to either must not quietly open the other.
    const forAlice = { ...base, target: "alice-cursor", state: "open", action: "created" } as const;
    assert.throws(
      () =>
        assertTaskTransition(
          forAlice,
          { ...forAlice, state: "claimed", action: "claimed", assignee: "komdosh-codex" },
          "komdosh-codex",
        ),
      /targeted to another agent/,
    );

    // The same guard still admits the agent it was actually aimed at.
    assert.doesNotThrow(() =>
      assertTaskTransition(
        forAlice,
        { ...forAlice, state: "claimed", action: "claimed", assignee: "alice-cursor" },
        "alice-cursor",
      ),
    );
  });

  it("rejects a claim on machine-targeted work that names no machine at all", () => {
    assert.throws(
      () =>
        claimEvent("bob-claude", {
          ...base,
          state: "claimed",
          action: "claimed",
          assignee: "bob-claude",
        }),
      /must record task_assignee_machine/,
      "otherwise anyone could claim work aimed at a machine by omitting a field",
    );
  });
});

/**
 * Three real transports on one remote: two agents sharing a machine, one on
 * another. Everything below is asserted through git rather than in memory,
 * because the whole claim of machine addressing is that it survives the trip.
 */
describe("machines across a real transport", () => {
  let tmp: string;
  let claude: Network;
  let codex: Network;
  let bob: Network;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "komnet-machine-"));
    const remote = join(tmp, "transport.git");
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);

    const open = async (home: string, id: string, machine: string): Promise<Network> =>
      (
        await Network.init({
          layout: new Layout(join(tmp, home)),
          networkId: "acme",
          remote,
          identity: identityOn(id, machine),
        })
      ).network;

    claude = await open("claude", "komdosh-claude", "komdosh-mbp");
    await claude.createRoom(ROOM);
    codex = await open("codex", "komdosh-codex", "komdosh-mbp");
    await codex.joinRoom(ROOM);
    bob = await open("bob", "bob-claude", "bob-mbp");
    await bob.joinRoom(ROOM);
    for (const net of [claude, codex, bob]) await net.publishAgentCard();
    for (const net of [claude, codex, bob]) await net.sync();
  });

  after(async () => {
    for (const net of [claude, codex, bob]) net.close();
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("groups the roster by computer, this machine first", async () => {
    const machines = await claude.machines();
    assert.equal(machines[0]?.id, "komdosh-mbp");
    assert.equal(machines[0]?.self, true);
    assert.deepEqual(
      machines[0]?.agents.map((agent) => agent.id),
      ["komdosh-claude", "komdosh-codex"],
    );
    const other = machines.find((machine) => machine.id === "bob-mbp");
    assert.deepEqual(
      other?.agents.map((agent) => agent.id),
      ["bob-claude"],
    );
    assert.equal(other?.self, false);
    assert.equal(other?.contested, false);
  });

  it("reports the other agent on this computer, and never itself", async () => {
    assert.deepEqual(
      (await claude.peers()).map((peer) => peer.id),
      ["komdosh-codex"],
    );
    assert.deepEqual(
      (await bob.peers()).map((peer) => peer.id),
      [],
      "an agent alone on its box has no peers",
    );
  });

  it("delivers one machine-addressed question to every agent on that machine", async () => {
    // The failure this prevents: asking "komdosh-claude" when codex is the one
    // that is awake, and waiting all afternoon.
    const sent = await bob.send(ROOM, {
      body: "which of you has the checkout service running?",
      kind: "question",
      needs: "agent",
      mentions: [machineMention("komdosh-mbp")],
    });

    // The token survives onto the wire alongside the ids it resolved to.
    assert.ok(sent.header.mentions.includes("machine:komdosh-mbp"));
    assert.ok(sent.header.mentions.includes("komdosh-claude"));
    assert.ok(sent.header.mentions.includes("komdosh-codex"));

    for (const net of [claude, codex]) {
      await net.sync();
      const inbox = net.inbox();
      assert.ok(
        inbox.some((item) => item.id === sent.header.id),
        `${net.identity.id} must receive a question addressed to its machine`,
      );
    }
  });

  it("does not deliver a machine question to an agent on another machine", async () => {
    const sent = await claude.send(ROOM, {
      body: "bob's box only",
      kind: "question",
      needs: "agent",
      mentions: [machineMention("bob-mbp")],
    });
    await codex.sync();
    assert.equal(
      codex.inbox().some((item) => item.id === sent.header.id),
      false,
      "addressing one machine must not fan out to the rest of the room",
    );
    await bob.sync();
    assert.ok(bob.inbox().some((item) => item.id === sent.header.id));
  });

  it("forecasts a machine mention as reaching the agents behind it", async () => {
    const forecast = await bob.forecastDelivery(ROOM, [machineMention("komdosh-mbp")]);
    assert.deepEqual(forecast.map((row) => [row.agent, row.outlook]).sort(), [
      ["komdosh-claude", "reaches"],
      ["komdosh-codex", "reaches"],
    ]);
  });

  it("says so plainly when a machine mention resolves to nobody", async () => {
    const [row] = await bob.forecastDelivery(ROOM, [machineMention("no-such-box")]);
    assert.equal(row?.agent, "machine:no-such-box");
    assert.equal(row?.outlook, "unknown");
    assert.match(row?.reason ?? "", /no agent/);
  });

  it("gives the agents on one computer a shared room, from either side", async () => {
    const first = await claude.machineRoom();
    assert.equal(first.room, "komdosh-mbp");
    assert.equal(first.created, true);

    // The second session on the box derives the SAME name and joins rather than
    // failing — two agents starting together is the normal case, not a race.
    const second = await codex.machineRoom();
    assert.equal(second.room, first.room);
    assert.equal(second.created, false);
    assert.equal(second.joined, true);

    // Idempotent: an agent already in its machine room does nothing.
    assert.deepEqual(await codex.machineRoom(), {
      room: "komdosh-mbp",
      created: false,
      joined: false,
    });

    const hello = await claude.send(first.room, {
      body: "taking packages/core; you take packages/cli",
      kind: "status",
      needs: "none",
      mentions: [machineMention("komdosh-mbp")],
    });
    await codex.sync();
    assert.ok(codex.inbox().some((item) => item.id === hello.header.id));
  });

  it("counts live peers on status, so a session knows whether it is alone", async () => {
    await claude.announce("live");
    await codex.announce("live");
    await codex.sync();
    const status = await codex.status();
    assert.equal(status.machine.id, "komdosh-mbp");
    assert.equal(status.machine.peers, 1);
    assert.equal(status.machine.livePeers, 1);
    assert.equal((await bob.status()).machine.peers, 0);
  });
});

/**
 * Work handed to a computer rather than to one agent on it.
 *
 * This is the case a team actually has: the box with the checkout and the
 * running service can do the job, and which of the sessions open on it is free
 * is not knowable to whoever is asking.
 */
describe("a task targeted at a machine", () => {
  let tmp: string;
  let claude: Network;
  let codex: Network;
  let bob: Network;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "komnet-machine-task-"));
    const remote = join(tmp, "transport.git");
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);

    const open = async (home: string, id: string, machine: string): Promise<Network> => {
      const layout = new Layout(join(tmp, home));
      const net = (
        await Network.init({ layout, networkId: "acme", remote, identity: identityOn(id, machine) })
      ).network;
      // The inbound-work gate has its own suite in policy.test.ts; this one is
      // about who a machine target admits, so approval is taken off the table.
      await writeFile(join(tmp, home, "policy.yaml"), "v: 1\napprovals:\n  inboundWork: never\n");
      return net;
    };

    claude = await open("claude", "komdosh-claude", "komdosh-mbp");
    await claude.createRoom(ROOM);
    codex = await open("codex", "komdosh-codex", "komdosh-mbp");
    await codex.joinRoom(ROOM);
    bob = await open("bob", "bob-claude", "bob-mbp");
    await bob.joinRoom(ROOM);
    for (const net of [claude, codex, bob]) await net.publishAgentCard();
    for (const net of [claude, codex, bob]) await net.sync();
  });

  after(async () => {
    for (const net of [claude, codex, bob]) net.close();
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("offers the work to every agent on the machine, and to no one else", async () => {
    const created = await bob.createTask(ROOM, {
      title: "Regenerate the checkout fixtures",
      definition: "Whoever on that box is free. Needs the service running locally.",
      target: machineMention("komdosh-mbp"),
    });
    const taskId = created.header.task?.id as string;
    assert.equal(created.header.task?.target, "machine:komdosh-mbp");

    for (const net of [claude, codex]) {
      await net.sync();
      const entry = (await net.agenda({ includeUnclaimed: true })).entries.find(
        (candidate) => candidate.status.task.id === taskId,
      );
      assert.equal(
        entry?.relation,
        "offered",
        `${net.identity.id} must see work aimed at its machine as offered, not as free backlog`,
      );
    }

    // Exactly one wins, and the loser is told why rather than silently
    // producing a second assignee.
    await codex.claimTask(ROOM, taskId, "Taking it — the service is already up here.");
    await claude.sync();
    await assert.rejects(
      () => claude.claimTask(ROOM, taskId, "Also taking it."),
      /already claimed by komdosh-codex/,
      "the loser must be refused, and told who won — they race for this by design",
    );

    const status = (await codex.listTasks(ROOM)).find((row) => row.task.id === taskId);
    assert.equal(status?.task.assignee, "komdosh-codex");
    assert.equal(
      status?.task.target,
      "machine:komdosh-mbp",
      "the target records where it was sent",
    );
  });

  it("refuses a claim from an agent on a different machine", async () => {
    const created = await claude.createTask(ROOM, {
      title: "Rotate the staging credentials",
      definition: "Only the box that holds them.",
      target: machineMention("komdosh-mbp"),
    });
    const taskId = created.header.task?.id as string;
    await bob.sync();
    await assert.rejects(
      () => bob.claimTask(ROOM, taskId, "I'll do it."),
      /not to this machine/,
      "a machine target is a boundary, not a suggestion",
    );

    // And the refusal did not corrupt the task: it is still open and claimable
    // by the machine it was actually addressed to.
    await codex.sync();
    await codex.claimTask(ROOM, taskId, "Mine — the credentials are on this box.");
    const status = (await codex.listTasks(ROOM)).find((row) => row.task.id === taskId);
    assert.equal(status?.task.state, "claimed");
    assert.equal(status?.task.assignee, "komdosh-codex");
  });
});
