import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { openBackend } from "@komnet/daemon";
import { describeError, Layout, loadConfig, resolveProjectBinding } from "@komnet/core";

import { createMcpServer } from "./server.ts";

export interface RunStdioOptions {
  network?: string;
  /** Project directory supplied by the desktop host; defaults to process.cwd(). */
  projectPath?: string;
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
  const layout = new Layout();
  const projectPath = options.projectPath ?? process.cwd();
  const config = await loadConfig(layout.configPath);
  const candidate = config === null ? null : resolveProjectBinding(config, projectPath);
  const project =
    candidate !== null && (options.network === undefined || options.network === candidate.network)
      ? candidate
      : null;
  const selectedNetwork = options.network ?? project?.network;
  const backend = await openBackend({
    layout,
    projectPath,
    ...(selectedNetwork === undefined ? {} : { network: selectedNetwork }),
    ...(options.direct === true ? { forceDirect: true } : {}),
    client: "mcp",
    // This process lives exactly as long as the agent session does, which is
    // what makes the published presence a fact rather than a guess.
    session: true,
  });

  if (project !== null) {
    await backend
      .call("profileUpdate", { input: { role: project.role } })
      .catch((error) =>
        process.stderr.write(
          `komnet mcp: project role is saved locally but could not be published yet: ${describeError(error)}\n`,
        ),
      );
  }

  const server = createMcpServer(
    backend,
    project === null ? undefined : { network: project.network, role: project.role },
  );
  process.stderr.write(
    `komnet mcp: ${backend.mode} mode${
      project === null ? "" : ` · network ${project.network} · role ${project.role}`
    }\n`,
  );

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
