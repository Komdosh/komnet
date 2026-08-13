import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { openBackend } from "@komnet/daemon";

import { createMcpServer } from "./server.ts";

export interface RunStdioOptions {
  network?: string;
  /** Bypass the daemon even if one is running. */
  direct?: boolean;
}

/**
 * Serve komnet over MCP on stdio.
 *
 * stdout is the transport: anything written there that is not a protocol
 * message corrupts the stream, so every diagnostic goes to stderr, which the
 * host surfaces in its MCP log.
 *
 * Resolves when the transport closes.
 */
export async function runStdioServer(options: RunStdioOptions = {}): Promise<void> {
  const backend = await openBackend({
    ...(options.network === undefined ? {} : { network: options.network }),
    ...(options.direct === true ? { forceDirect: true } : {}),
    client: "mcp",
    // This process lives exactly as long as the agent session does, which is
    // what makes the published presence a fact rather than a guess.
    session: true,
  });

  const server = createMcpServer(backend);
  process.stderr.write(`komnet mcp: ${backend.mode} mode\n`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    // Closing the backend tells the daemon this session ended. That writes
    // nothing — a departure is derived from the stamp going cold (ADR 0022) —
    // but it stops the daemon claiming an attached session it no longer has.
    await backend.close().catch(() => undefined);
  };

  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

  const transport = new StdioServerTransport();
  transport.onclose = () => void shutdown();

  await server.connect(transport);
}
