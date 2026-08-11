import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { openBackend } from "@kom-net/daemon";

import { createMcpServer } from "./server.ts";

export interface RunStdioOptions {
  network?: string;
  /** Bypass the daemon even if one is running. */
  direct?: boolean;
}

/**
 * Serve kom-net over MCP on stdio.
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
  });

  const server = createMcpServer(backend);
  process.stderr.write(`komnet mcp: ${backend.mode} mode\n`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    // Closing the backend tells the daemon this session ended, which publishes
    // the presence transition — that is what makes komnet_presence truthful
    // rather than guessed.
    await backend.close().catch(() => undefined);
  };

  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

  const transport = new StdioServerTransport();
  transport.onclose = () => void shutdown();

  await server.connect(transport);
}
