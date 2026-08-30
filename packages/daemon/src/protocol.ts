/**
 * Local IPC contract between the daemon and its clients (CLI, MCP server).
 *
 * Newline-delimited JSON over a unix domain socket. Deliberately not HTTP: the
 * socket's filesystem permissions (0600) are the authentication, so there is no
 * port to bind, no token to manage, and no listening TCP surface (ADR 0005).
 */

export const IPC_PROTOCOL_VERSION = 1;

export const METHODS = [
  "ping",
  "status",
  "sync",
  "rooms",
  "roomShow",
  "roomCreate",
  "roomJoin",
  "roomLeave",
  "send",
  "answer",
  "reviewRequest",
  "reviewUpdate",
  "reviewPrepare",
  "reviewRelease",
  "reviews",
  "taskCreate",
  "taskClaim",
  "taskUpdate",
  "tasks",
  "claim",
  "claimRelease",
  "claims",
  "taskShow",
  "agenda",
  "resume",
  "policy",
  "approvals",
  "approve",
  "approveRevoke",
  "read",
  "history",
  "search",
  "inbox",
  "health",
  "outbox",
  "surroundings",
  "networks",
  "trace",
  "forecastDelivery",
  "inboxDrain",
  "agents",
  "machines",
  "peers",
  "machineRoom",
  "profileGet",
  "profileUpdate",
  "presence",
  "announce",
  "handshake",
  "receipts",
  "mentions",
  "waitInbox",
  "seal",
  "sealCheck",
  "sessionOpen",
  "sessionClose",
  "shutdown",
] as const;

export type Method = (typeof METHODS)[number];

/**
 * Methods a daemonless process cannot serve, and why each one is on the list.
 *
 * This exists so "deliberately daemon-only" and "nobody implemented it in
 * direct mode" stop being the same thing. They used to produce an identical
 * runtime error, which meant a method added to METHODS and forgotten in the
 * direct-mode switch failed exactly like an intentional exclusion — for the
 * half of users running an editor without a daemon, and only at call time.
 *
 * `DirectMethod` closes that: the direct backend switches over it exhaustively,
 * so a new method must either be implemented there or be added here on purpose.
 *
 *  - `ping` / `shutdown`         — the daemon process's own lifecycle.
 *  - `sessionOpen` / `sessionClose` — presence is derived from an attached
 *    session, and a one-shot process has none to declare.
 *  - `networks`                  — served by `Backend.networks()` from local
 *    config, so it never travels through `call`.
 */
export const DAEMON_ONLY_METHODS = [
  "ping",
  "shutdown",
  "sessionOpen",
  "sessionClose",
  "networks",
] as const satisfies readonly Method[];

export type DaemonOnlyMethod = (typeof DAEMON_ONLY_METHODS)[number];

/** Everything the direct backend is required to implement. */
export type DirectMethod = Exclude<Method, DaemonOnlyMethod>;

export function isDaemonOnlyMethod(value: Method): value is DaemonOnlyMethod {
  return (DAEMON_ONLY_METHODS as readonly string[]).includes(value);
}

export interface IpcRequest {
  id: number;
  method: Method;
  /** Which network the call applies to; the daemon's default when omitted. */
  network?: string;
  params?: Record<string, unknown>;
}

export type IpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { message: string; code?: string } };

export function isMethod(value: string): value is Method {
  return (METHODS as readonly string[]).includes(value);
}

/**
 * Frame a stream of newline-delimited JSON.
 *
 * A single message can exceed one chunk and several can share one, so the
 * buffer is carried across `push` calls. Lines are size-capped: without a cap a
 * peer that never sends a newline would grow this buffer without bound.
 */
export class LineFramer {
  private buffer = "";
  private readonly maxLineBytes: number;

  constructor(maxLineBytes = 8 * 1024 * 1024) {
    this.maxLineBytes = maxLineBytes;
  }

  push(chunk: string): string[] {
    this.buffer += chunk;
    if (this.buffer.length > this.maxLineBytes) {
      this.buffer = "";
      throw new Error("IPC line exceeded the maximum length");
    }
    const lines: string[] = [];
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) lines.push(line);
      index = this.buffer.indexOf("\n");
    }
    return lines;
  }
}

export function encode(message: IpcRequest | IpcResponse): string {
  return `${JSON.stringify(message)}\n`;
}
