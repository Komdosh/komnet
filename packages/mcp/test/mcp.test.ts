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
  await rm(tmp, { recursive: true, force: true });
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
      "komnet_agents",
      "komnet_presence",
      "komnet_status",
      "komnet_decide",
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
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

    const read = await client.rpc("resources/read", { uri: "komnet://rooms" });
    const contents = (read.result?.["contents"] ?? []) as { text: string }[];
    const rooms = JSON.parse(contents[0]?.text ?? "[]") as { id: string }[];
    assert.ok(rooms.some((r) => r.id === "architecture"));
  });

  it("templates a room resource", async () => {
    const templates = await client.rpc("resources/templates/list");
    const list = (templates.result?.["resourceTemplates"] ?? []) as { uriTemplate: string }[];
    assert.ok(list.some((t) => t.uriTemplate === "komnet://room/{id}"));

    const read = await client.rpc("resources/read", { uri: "komnet://room/architecture" });
    assert.ok(read.result !== undefined, JSON.stringify(read.error));
  });

  it("lists rooms and sends a message", async () => {
    const rooms = await client.callTool<{ id: string }[]>("komnet_rooms");
    assert.ok(rooms.some((r) => r.id === "architecture"));

    const sent = await client.callTool<{ header: { id: string; kind: string } }>("komnet_send", {
      room: "architecture",
      body: "sent through MCP",
      kind: "msg",
    });
    assert.match(sent.header.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);

    const messages = await client.callTool<{ body: string }[]>("komnet_read", {
      room: "architecture",
    });
    assert.ok(messages.some((m) => m.body.includes("sent through MCP")));
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
    const inbox =
      await client.callTool<{ id: string; needs: string; from: string }[]>("komnet_inbox");
    const pending = inbox.find((i) => i.needs === "human" && i.from === "peer-claude");
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
    const still = await client.callTool<{ id: string }[]>("komnet_inbox");
    assert.ok(still.some((i) => i.id === pending.id));

    // The relay is deliberately not available through this tool; it uses the
    // interactive CLI and records asserted rather than authenticated provenance.
    const stillPending = await client.callTool<{ id: string }[]>("komnet_inbox");
    assert.ok(
      stillPending.some((i) => i.id === pending.id),
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
