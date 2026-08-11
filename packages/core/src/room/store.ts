import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import {
  isMessagePath,
  messagePath,
  parseMessage,
  serializeMessage,
  threadOrder,
  type Message,
} from "@kom-net/protocol";

/**
 * Reads and writes messages in one room's worktree.
 *
 * Operates on the filesystem rather than on git objects: the worktree IS the
 * live window, and a plain read must not require a git process. Anything older
 * than the window is reached through history instead (`Repo.readFile`).
 */
export class RoomStore {
  readonly worktree: string;
  readonly roomId: string;

  constructor(worktree: string, roomId: string) {
    this.worktree = worktree;
    this.roomId = roomId;
  }

  /** Directory holding this room's messages, relative to the worktree root. */
  get messageRoot(): string {
    return join("rooms", this.roomId, "msg");
  }

  /** Repo-relative paths of every message in the live window. */
  async listMessagePaths(): Promise<string[]> {
    const absoluteRoot = join(this.worktree, this.messageRoot);
    let entries;
    try {
      entries = await readdir(absoluteRoot, { recursive: true, withFileTypes: true });
    } catch (error) {
      // A room with no messages yet has no directory. That is not an error.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const paths: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const absolute = join(entry.parentPath, entry.name);
      // Normalise to forward slashes: protocol paths are repo paths, and this
      // must produce identical results on Windows.
      const repoPath = relative(this.worktree, absolute).split(sep).join("/");
      if (isMessagePath(repoPath)) paths.push(repoPath);
    }
    // Filenames are timestamp-prefixed, so a plain sort is chronological.
    return paths.sort();
  }

  async readMessageAt(repoPath: string): Promise<Message> {
    const raw = await readFile(join(this.worktree, repoPath), "utf8");
    return parseMessage(raw, repoPath);
  }

  /**
   * Every message in the live window, in thread order.
   *
   * `onError` receives files that failed to parse instead of aborting the read:
   * one malformed file must not make a whole room unreadable.
   */
  async readAll(onError?: (repoPath: string, error: unknown) => void): Promise<Message[]> {
    const paths = await this.listMessagePaths();
    const messages: Message[] = [];
    for (const repoPath of paths) {
      try {
        messages.push(await this.readMessageAt(repoPath));
      } catch (error) {
        if (onError === undefined) throw error;
        onError(repoPath, error);
      }
    }
    return threadOrder(messages);
  }

  /**
   * Write a message to its canonical path.
   *
   * Refuses to overwrite. Every message path embeds a ULID, so a collision means
   * either a duplicate send or an id-generation bug — both of which must surface
   * rather than silently destroy an existing message (ADR 0004).
   */
  async writeMessage(message: Message): Promise<string> {
    const repoPath = messagePath(message.header);
    const absolute = join(this.worktree, repoPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, serializeMessage(message), { encoding: "utf8", flag: "wx" });
    return repoPath;
  }
}
