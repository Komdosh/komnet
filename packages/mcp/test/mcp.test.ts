import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

const exec = promisify(execFile);

process.env["GIT_AUTHOR_NAME"] = "komnet test";
process.env["GIT_AUTHOR_EMAIL"] = "test@komnet.invalid";
process.env["GIT_COMMITTER_NAME"] = "komnet test";
process.env["GIT_COMMITTER_EMAIL"] = "test@komnet.invalid";
process.env["NO_COLOR"] = "1";

const CLI = join(import.meta.dirname, "..", "..", "cli", "dist", "bin.js");

interface RpcMessage {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * A minimal MCP stdio client.
 *
 * Hand-rolled rather than using an SDK client on purpose: this asserts what
 * actually goes over the wire, including that stdout carries nothing but
 * JSON-RPC — a single stray `console.log` in the server would corrupt the
 * transport for every host.
 */
class McpTestClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (message: RpcMessage) => void>();
  readonly stdoutLines: string[] = [];
  readonly stderr: string[] = [];

  constructor(home: string, extraArgs: string[] = []) {
    this.child = spawn(process.execPath, [CLI, "mcp", ...extraArgs], {
      env: { ...process.env, KOMNET_HOME: home, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) {
        this.stdoutLines.push(line);
        try {
          const message = JSON.parse(line) as RpcMessage;
          if (message.id !== undefined) {
            this.pending.get(message.id)?.(message);
            this.pending.delete(message.id);
          }
        } catch {
          // Kept in stdoutLines so the "stdout is pure JSON-RPC" test can fail on it.
        }
      }
      index = this.buffer.indexOf("\n");
    }
  }

  async rpc(method: string, params: unknown = {}): Promise<RpcMessage> {
    const id = this.nextId++;
    return await new Promise<RpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 30_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize(): Promise<RpcMessage> {
    const result = await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "komnet-test", version: "1.0.0" },
    });
    this.notify("notifications/initialized");
    return result;
  }

  /** The text payload of a tool result, parsed when it is JSON. */
  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const response = await this.rpc("tools/call", { name, arguments: args });
    const content = (response.result?.["content"] ?? []) as { type: string; text: string }[];
    const text = content.map((c) => c.text).join("");
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  kill(): void {
    this.child.kill();
  }
}

let tmp: string;
let remote: string;
let home: string;
let client: McpTestClient;

async function komnet(...args: string[]): Promise<string> {
  const { stdout } = await exec(process.execPath, [CLI, ...args], {
    env: { ...process.env, KOMNET_HOME: home, NO_COLOR: "1" },
  });
  return stdout;
}

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "komnet-mcp-"));
  remote = join(tmp, "transport.git");
  home = join(tmp, "home");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  await komnet("init", "--repo", remote, "--network", "acme", "--agent", "mcp-agent");
  await komnet("room", "create", "architecture", "--title", "Architecture");

  client = new McpTestClient(home, ["--direct"]);
  await client.initialize();
});

after(async () => {
  client.kill();
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("MCP server", () => {
  it("completes the handshake and ships the operating guide", async () => {
    const fresh = new McpTestClient(home, ["--direct"]);
    try {
      const result = await fresh.initialize();
      const info = result.result?.["serverInfo"] as { name: string; version: string };
      assert.equal(info.name, "komnet");
      assert.match(result.result?.["protocolVersion"] as string, /^\d{4}-\d{2}-\d{2}$/);

      // The rules must reach the model, not only the docs — a rule stated only
      // in a README is a rule the agent will break.
      const instructions = result.result?.["instructions"] as string;
      assert.match(instructions, /needs.*human/i);
      assert.match(instructions, /permanent/i);
      assert.match(instructions, /review.*needs:agent/i);
      assert.match(instructions, /task.*claim/i);
      assert.match(instructions, /stale.*blocked.*stuck/i);
      assert.match(instructions, /komnet_profile action=update.*role.*current/i);
    } finally {
      fresh.kill();
    }
  });

  it("writes nothing but JSON-RPC to stdout", async () => {
    await client.callTool("komnet_status");
    for (const line of client.stdoutLines) {
      assert.doesNotThrow(
        () => JSON.parse(line),
        `stdout must carry only protocol messages, got: ${line.slice(0, 80)}`,
      );
    }
    // Diagnostics belong on stderr, where the host shows them in its MCP log.
    assert.match(client.stderr.join(""), /direct mode/);
  });

  it("exposes the documented tool surface", async () => {
    const response = await client.rpc("tools/list");
    const tools = (response.result?.["tools"] ?? []) as { name: string; description: string }[];
    const names = tools.map((t) => t.name);

    for (const expected of [
      "komnet_inbox",
      "komnet_rooms",
      "komnet_read",
      "komnet_history",
      "komnet_search",
      "komnet_send",
      "komnet_ask",
      "komnet_answer",
      "komnet_review",
      "komnet_task_create",
      "komnet_task_claim",
      "komnet_task_update",
      "komnet_tasks",
      "komnet_task_show",
      "komnet_agenda",
      "komnet_policy",
      "komnet_agents",
      "komnet_profile",
      "komnet_presence",
      "komnet_status",
      "komnet_decide",
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }

    // Some operations are the human's, and are absent on purpose.
    //
    // Approving inbound work: an agent that can approve its own work is an
    // ungated gate. Creating/joining/leaving rooms: each restructures the
    // network rather than using it, and the CLI is where the person is.
    for (const forbidden of [
      "komnet_approve",
      "komnet_task_approve",
      "komnet_policy_update",
      "komnet_room_create",
      "komnet_room_join",
      "komnet_room_leave",
    ]) {
      assert.ok(!names.includes(forbidden), `${forbidden} must not be exposed over MCP`);
    }

    const answer = tools.find((t) => t.name === "komnet_answer");
    assert.match(
      answer?.description ?? "",
      /needs='human'/,
      "the human-in-the-loop rule must be in the description the model reads",
    );
  });

  it("exposes resources so a room can be read without a tool call", async () => {
    const response = await client.rpc("resources/list");
    const uris = ((response.result?.["resources"] ?? []) as { uri: string }[]).map((r) => r.uri);
    assert.ok(uris.includes("komnet://inbox"));
    assert.ok(uris.includes("komnet://rooms"));
    assert.ok(uris.includes("komnet://profile"));

    const read = await client.rpc("resources/read", { uri: "komnet://rooms" });
    const contents = (read.result?.["contents"] ?? []) as { text: string }[];
    const rooms = JSON.parse(contents[0]?.text ?? "[]") as { id: string }[];
    assert.ok(rooms.some((r) => r.id === "architecture"));

    const inboxRead = await client.rpc("resources/read", { uri: "komnet://inbox" });
    const inboxContents = (inboxRead.result?.["contents"] ?? []) as { text: string }[];
    const inbox = JSON.parse(inboxContents[0]?.text ?? "{}") as {
      health?: { degraded?: boolean };
      items?: unknown[];
    };
    assert.equal(
      typeof inbox.health?.degraded,
      "boolean",
      "transport health must accompany the items even before the first successful sync",
    );
    assert.ok(Array.isArray(inbox.items));
  });

  it("templates a room resource", async () => {
    const templates = await client.rpc("resources/templates/list");
    const list = (templates.result?.["resourceTemplates"] ?? []) as { uriTemplate: string }[];
    assert.ok(list.some((t) => t.uriTemplate === "komnet://room/{id}"));

    const read = await client.rpc("resources/read", { uri: "komnet://room/architecture" });
    assert.ok(read.result !== undefined, JSON.stringify(read.error));
  });

  it("returns transport health with a bounded wait", async () => {
    const waited = await client.callTool<{
      health?: { degraded?: boolean };
      timedOut?: boolean;
      items?: unknown[];
    }>("komnet_wait", { room: "architecture", tag: "never-arrives", timeoutSec: 1 });
    assert.equal(waited.timedOut, true);
    assert.equal(
      typeof waited.health?.degraded,
      "boolean",
      "a timeout without health can make a broken transport look like a quiet peer",
    );
    assert.deepEqual(waited.items, []);
  });

  it("lists rooms and sends a message", async () => {
    const rooms = await client.callTool<{ id: string }[]>("komnet_rooms");
    assert.ok(rooms.some((r) => r.id === "architecture"));

    // A send reports whether its mentions can actually receive it, because
    // routing delivers only within a recipient's subscriptions.
    const sent = await client.callTool<{
      message: { header: { id: string; kind: string } };
      delivery: { agent: string; outlook: string }[];
    }>("komnet_send", { room: "architecture", body: "sent through MCP", kind: "msg" });
    assert.match(sent.message.header.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.deepEqual(sent.delivery, [], "nothing was mentioned, so nothing to forecast");

    const messages = await client.callTool<{ body: string }[]>("komnet_read", {
      room: "architecture",
    });
    assert.ok(messages.some((m) => m.body.includes("sent through MCP")));
  });

  it("describes this agent and exposes its role through discovery", async () => {
    const updated = await client.callTool<{
      published: boolean;
      profile: {
        role: string;
        currentFocus: string;
        environment: { client: string; platform: string; architecture: string };
      };
    }>("komnet_profile", {
      action: "update",
      role: "Protocol integration engineer",
      mission: "Help the team coordinate engineering work safely.",
      currentFocus: "Validating MCP agent profiles.",
      workspace: "github.com/acme/komnet",
      capabilities: ["Inspect and modify TypeScript code"],
      responsibilities: ["Keep MCP and protocol behavior aligned"],
      constraints: ["Cannot approve decisions for the human"],
      canHelpWith: ["KomNet protocol and MCP integration"],
    });
    assert.equal(updated.published, true);
    assert.equal(updated.profile.role, "Protocol integration engineer");
    assert.equal(updated.profile.environment.client, "mcp");

    const own = await client.callTool<{ role: string }>("komnet_profile", { action: "read" });
    assert.equal(own.role, "Protocol integration engineer");
    const agents = await client.callTool<{ id: string; role?: string }[]>("komnet_agents");
    assert.equal(agents.find((agent) => agent.id === "mcp-agent")?.role, updated.profile.role);

    const resource = await client.rpc("resources/read", { uri: "komnet://profile" });
    const contents = (resource.result?.["contents"] ?? []) as { text: string }[];
    assert.equal(
      (JSON.parse(contents[0]?.text ?? "{}") as { role?: string }).role,
      updated.profile.role,
    );
  });

  it("creates and guards a repository review task", async () => {
    const requested = await client.callTool<{
      header: { review: { id: string; state: string }; needs: string };
    }>("komnet_review", {
      action: "request",
      room: "architecture",
      reviewer: "peer-reviewer",
      repo: "github.com/acme/payments",
      baseRev: "1".repeat(40),
      headRev: "2".repeat(40),
      summary: "Review refund idempotency.",
      scope: ["src/refunds"],
    });
    assert.equal(requested.header.needs, "agent");
    assert.equal(requested.header.review.state, "requested");

    const reviews = await client.callTool<{ review: { id: string; state: string } }[]>(
      "komnet_review",
      { action: "list", room: "architecture" },
    );
    assert.ok(reviews.some((task) => task.review.id === requested.header.review.id));

    const cancelled = await client.callTool<{
      header: { review: { state: string }; needs: string };
    }>("komnet_review", {
      action: "update",
      room: "architecture",
      reviewId: requested.header.review.id,
      state: "cancelled",
      body: "Superseded by a newer revision.",
    });
    assert.equal(cancelled.header.review.state, "cancelled");
    assert.equal(cancelled.header.needs, "none");
  });

  // komnet_review, komnet_claim and komnet_profile dispatch on `action`, and JSON
  // Schema cannot express "required when action=update". That contract therefore
  // lives in the handler, and this asserts it still holds — otherwise an omitted
  // field reaches the backend as a rejection the model cannot map back to the
  // argument it forgot.
  it("names the missing argument when an action-dispatched tool is under-specified", async () => {
    const missingBody = await client.callTool<string>("komnet_review", {
      action: "update",
      room: "architecture",
      reviewId: "01KZREVIEW0000000000000000",
      state: "reviewing",
    });
    assert.match(String(missingBody), /komnet_review[\s\S]*requires[\s\S]*body/);

    const missingReviewId = await client.callTool<string>("komnet_review", {
      action: "prepare",
      room: "architecture",
    });
    assert.match(String(missingReviewId), /komnet_review[\s\S]*requires[\s\S]*reviewId/);

    const missingResource = await client.callTool<string>("komnet_claim", {
      action: "release",
      room: "architecture",
    });
    assert.match(String(missingResource), /komnet_claim[\s\S]*requires[\s\S]*resource/);

    const peerUpdate = await client.callTool<string>("komnet_profile", {
      action: "update",
      agent: "peer-reviewer",
      role: "Impostor",
    });
    assert.match(String(peerUpdate), /read-only|only its own/);
  });

  it("acquires, lists, and releases a lease through one claim tool", async () => {
    const acquired = await client.callTool<{ granted: boolean }>("komnet_claim", {
      action: "acquire",
      room: "architecture",
      resource: "core/social/graph",
      note: "Collapsing the MCP surface.",
    });
    assert.equal(acquired.granted, true);

    const held = await client.callTool<unknown>("komnet_claim", {
      action: "list",
      room: "architecture",
    });
    assert.ok(JSON.stringify(held).includes("core/social/graph"));

    await client.callTool("komnet_claim", {
      action: "release",
      room: "architecture",
      resource: "core/social/graph",
    });
    const afterRelease = await client.callTool<unknown>("komnet_claim", {
      action: "list",
      room: "architecture",
    });
    assert.ok(!JSON.stringify(afterRelease).includes("core/social/graph"));
  });

  it("creates, claims, advances, and lists a collaborative task", async () => {
    const created = await client.callTool<{
      header: { task: { id: string; state: string }; needs: string; mentions: string[] };
    }>("komnet_task_create", {
      room: "architecture",
      title: "Task MCP surface",
      definition: "Expose the complete guarded task lifecycle.",
      staleAfterSeconds: 3600,
    });
    assert.equal(created.header.task.state, "open");
    assert.equal(created.header.needs, "agent");
    assert.deepEqual(created.header.mentions, ["@room"]);

    const claimed = await client.callTool<{
      header: { task: { state: string; assignee: string } };
    }>("komnet_task_claim", {
      room: "architecture",
      taskId: created.header.task.id,
      note: "Claimed; implementing lifecycle adapters first.",
    });
    assert.equal(claimed.header.task.state, "claimed");
    assert.equal(claimed.header.task.assignee, "mcp-agent");

    await client.callTool("komnet_task_update", {
      room: "architecture",
      taskId: created.header.task.id,
      action: "started",
      body: "Implementation started.",
    });
    const completed = await client.callTool<{
      header: { task: { state: string }; needs: string };
    }>("komnet_task_update", {
      room: "architecture",
      taskId: created.header.task.id,
      action: "completed",
      body: "MCP tools and contract checks are complete.",
    });
    assert.equal(completed.header.task.state, "completed");
    assert.equal(completed.header.needs, "none");

    const tasks = await client.callTool<
      { task: { id: string; state: string }; health: string; stale: boolean }[]
    >("komnet_tasks", { room: "architecture" });
    const status = tasks.find((task) => task.task.id === created.header.task.id);
    assert.equal(status?.task.state, "completed");
    assert.equal(status?.health, "done");
    assert.equal(status?.stale, false);
  });

  it("returns one task in full, and this agent's cross-room agenda", async () => {
    const created = await client.callTool<{ header: { task: { id: string } } }>(
      "komnet_task_create",
      {
        room: "architecture",
        title: "Resumable task context",
        definition: "Carry enough context that a fresh session can continue the work.",
      },
    );
    const taskId = created.header.task.id;
    await client.callTool("komnet_task_claim", {
      room: "architecture",
      taskId,
      note: "Taking it.",
    });
    await client.callTool("komnet_task_update", {
      room: "architecture",
      taskId,
      action: "started",
      body: "Read the reducer; the events already carry everything needed.",
    });

    const detail = await client.callTool<{
      task: { id: string; state: string; assignee: string };
      definition: string;
      participants: string[];
      events: { action: string; body: string }[];
    }>("komnet_task_show", { room: "architecture", taskId });
    assert.equal(detail.task.state, "in_progress");
    assert.equal(detail.task.assignee, "mcp-agent");
    assert.deepEqual(
      detail.events.map((event) => event.action),
      ["created", "claimed", "started"],
    );
    assert.match(detail.events[2]?.body ?? "", /already carry everything/);
    assert.deepEqual(detail.participants, ["mcp-agent"]);

    const agenda = await client.callTool<{
      entries: { room: string; relation: string; status: { task: { id: string } } }[];
      counts: { assigned: number };
    }>("komnet_agenda", {});
    const entry = agenda.entries.find((candidate) => candidate.status.task.id === taskId);
    assert.equal(entry?.relation, "assigned");
    assert.equal(entry?.room, "architecture");
    assert.ok(agenda.counts.assigned >= 1);
  });

  it("reports the local policy so an agent can explain a refusal it just hit", async () => {
    const resolved = await client.callTool<{
      policy: { approvals: { inboundWork: string; localAgents: string[] } };
      sources: string[];
    }>("komnet_policy", {});
    assert.equal(resolved.policy.approvals.inboundWork, "remote");
    assert.deepEqual(resolved.policy.approvals.localAgents, []);
    assert.ok(Array.isArray(resolved.sources));
  });

  it("tells the asker when a mention cannot possibly receive the question", async () => {
    // Asking and then waiting is the whole workflow; if the mention cannot land
    // the wait never ends, and silence looks exactly like being ignored.
    const asked = await client.callTool<{
      message: { header: { id: string } };
      delivery: { agent: string; outlook: string; reason: string }[];
    }>("komnet_ask", {
      room: "architecture",
      question: "did the retry contract move?",
      mentions: ["ghost-agent"],
    });
    assert.match(asked.message.header.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    const ghost = asked.delivery.find((entry) => entry.agent === "ghost-agent");
    assert.equal(
      ghost?.outlook,
      "unknown",
      "an id with no card is unknown, never a false 'misses'",
    );
    assert.match(ghost?.reason ?? "", /roster/);
  });

  it("refuses a send containing a credential", async () => {
    const result = await client.callTool<string>("komnet_send", {
      room: "architecture",
      body: "aws key AKIAIOSFODNN7EXAMPLE",
    });
    const rendered = typeof result === "string" ? result : JSON.stringify(result);
    assert.match(rendered, /secret/i);
    assert.doesNotMatch(rendered, /AKIAIOSFODNN7EXAMPLE/, "must not echo the secret back");
  });

  it("validates tool arguments instead of failing deep inside", async () => {
    const response = await client.rpc("tools/call", { name: "komnet_read", arguments: {} });
    const rendered = JSON.stringify(response.result ?? response.error);
    assert.match(rendered, /validation|required|expected string/i);
  });

  it("searches and reads history", async () => {
    const hits = await client.callTool<{ room: string }[]>("komnet_search", {
      query: "through MCP",
    });
    assert.ok(hits.length >= 1);

    const history = await client.callTool<unknown[]>("komnet_history", { room: "architecture" });
    assert.ok(Array.isArray(history));
  });

  it("keeps needs:human off the ordinary MCP answer path", async () => {
    // MCP deliberately has no human-relay switch. This is workflow separation,
    // not proof that an agent cannot reach the interactive CLI or core API.
    //
    // The question must come from a DIFFERENT agent: routing never delivers a
    // message back to its own author, so asking from this agent would leave the
    // inbox empty and the assertion below would never run.
    const peerHome = join(tmp, "peer");
    const peer = async (...args: string[]) => {
      await exec(process.execPath, [CLI, ...args], {
        env: { ...process.env, KOMNET_HOME: peerHome, NO_COLOR: "1" },
      });
    };
    await peer("init", "--repo", remote, "--network", "acme", "--agent", "peer-claude");
    await peer("room", "join", "architecture");
    await peer(
      "ask",
      "architecture",
      "Should we ship on Friday?",
      "--needs",
      "human",
      "--mention",
      "mcp-agent",
    );

    await client.callTool("komnet_sync");
    // `komnet_inbox` returns health alongside the items, so an agent can never
    // read an empty list without also reading why it might be empty.
    const inbox = await client.callTool<{
      health: { degraded: boolean };
      items: { id: string; needs: string; from: string }[];
    }>("komnet_inbox");
    assert.equal(inbox.health.degraded, false, "a freshly synced network is not degraded");
    const pending = inbox.items.find((i) => i.needs === "human" && i.from === "peer-claude");
    assert.ok(pending, "the peer's needs:human question must reach this agent's inbox");

    const refusal = await client.callTool<string>("komnet_answer", {
      messageId: pending.id,
      body: "Yes, ship it.",
    });
    assert.match(
      typeof refusal === "string" ? refusal : JSON.stringify(refusal),
      /direct agent path will not answer it/,
      "the MCP path must require the explicit relay flow",
    );

    // There is no MCP parameter that turns this call into a relay. The separate
    // CLI relay remains cooperative and intentionally outside this schema.
    const forged = await client.rpc("tools/call", {
      name: "komnet_answer",
      arguments: { messageId: pending.id, body: "Yes.", authorKind: "human" },
    });
    const rendered = JSON.stringify(forged.result ?? forged.error);
    assert.doesNotMatch(
      rendered,
      /"authorKind":\s*"human".*recorded/,
      "an unknown authorKind must not grant human authority",
    );

    // And it stays pending: a refusal must not consume the item.
    const still = await client.callTool<{ items: { id: string }[] }>("komnet_inbox");
    assert.ok(still.items.some((i) => i.id === pending.id));

    // The relay is deliberately not available through this tool; it uses the
    // interactive CLI and records asserted rather than authenticated provenance.
    const stillPending = await client.callTool<{ items: { id: string }[] }>("komnet_inbox");
    assert.ok(
      stillPending.items.some((i) => i.id === pending.id),
      "the question must remain pending until a human answers it elsewhere",
    );
  });

  it("reports status including which mode it is using", async () => {
    const status = await client.callTool<{ agentId: string; subscriptions: string[] }>(
      "komnet_status",
    );
    assert.equal(status.agentId, "mcp-agent");
    assert.ok(status.subscriptions.includes("architecture"));
  });
});
