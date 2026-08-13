import { connect, type Socket } from "node:net";

import type { AgentRuntimeEnvironment } from "@komnet/core";

import { LineFramer, encode, type IpcRequest, type IpcResponse, type Method } from "./protocol.ts";

export class DaemonUnavailableError extends Error {
  constructor(socketPath: string, cause?: unknown) {
    super(`no komnet daemon at ${socketPath}`, cause === undefined ? undefined : { cause });
    this.name = "DaemonUnavailableError";
  }
}

export class DaemonRequestError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "DaemonRequestError";
    this.code = code;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

/**
 * Client for the daemon's unix socket.
 *
 * Everything here is best-effort by design: if the daemon is not running the
 * caller falls back to direct mode (ADR 0005), so a missing daemon degrades the
 * experience rather than breaking the tool.
 */
export class DaemonClient {
  private readonly socket: Socket;
  private readonly framer = new LineFramer();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("close", () => this.failAll(new Error("daemon connection closed")));
    socket.on("error", (error) => this.failAll(error));
  }

  static async connect(socketPath: string, timeoutMs = 3_000): Promise<DaemonClient> {
    return await new Promise<DaemonClient>((resolve, reject) => {
      const socket = connect(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new DaemonUnavailableError(socketPath, new Error("timed out")));
      }, timeoutMs);
      timer.unref();

      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        resolve(new DaemonClient(socket));
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(new DaemonUnavailableError(socketPath, error));
      });
    });
  }

  /** Connect, or null if no daemon is there. Never throws for that reason. */
  static async tryConnect(socketPath: string, timeoutMs = 1_500): Promise<DaemonClient | null> {
    try {
      return await DaemonClient.connect(socketPath, timeoutMs);
    } catch {
      return null;
    }
  }

  /**
   * Whether a live daemon owns this socket path.
   *
   * Used before binding: a socket file left behind by a crash is debris to be
   * removed, but a socket someone is answering on means a second daemon must
   * not start.
   */
  static async isAlive(socketPath: string, timeoutMs = 1_000): Promise<boolean> {
    const client = await DaemonClient.tryConnect(socketPath, timeoutMs);
    if (client === null) return false;
    try {
      await client.request("ping", {}, undefined, timeoutMs);
      return true;
    } catch {
      return false;
    } finally {
      client.close();
    }
  }

  private onData(chunk: string): void {
    let lines: string[];
    try {
      lines = this.framer.push(chunk);
    } catch (error) {
      this.failAll(error);
      return;
    }
    for (const line of lines) {
      let response: IpcResponse;
      try {
        response = JSON.parse(line) as IpcResponse;
      } catch {
        continue;
      }
      const pending = this.pending.get(response.id);
      if (pending === undefined) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new DaemonRequestError(response.error.message, response.error.code));
    }
  }

  private failAll(error: unknown): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async request<T = unknown>(
    method: Method,
    params: Record<string, unknown> = {},
    network?: string,
    timeoutMs = 120_000,
  ): Promise<T> {
    if (this.closed) throw new Error("daemon client is closed");
    const id = this.nextId++;
    const request: IpcRequest = {
      id,
      method,
      params,
      ...(network === undefined ? {} : { network }),
    };

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`daemon did not answer '${method}' within ${String(timeoutMs)}ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.socket.write(encode(request));
    });
  }

  /**
   * Which agent this daemon serves, or null if it will not say.
   *
   * Asked before trusting a socket: the daemon is per-`KOMNET_HOME`, so one
   * answering for a different identity means the caller's home resolved
   * somewhere else, and reading that daemon's inbox would be reading another
   * agent's mail.
   */
  async identity(): Promise<string | null> {
    const pong = await this.request<{ agent?: unknown }>("ping", {}, undefined, 5_000);
    return typeof pong.agent === "string" ? pong.agent : null;
  }

  /**
   * Declare this connection an agent session.
   *
   * The daemon uses it for presence and to force the hot cadence — which is
   * accurate precisely because an MCP server's lifetime is the session's
   * lifetime.
   */
  async openSession(environment?: AgentRuntimeEnvironment): Promise<void> {
    await this.request("sessionOpen", environment === undefined ? {} : { environment });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("client closed"));
    this.socket.destroy();
  }
}
