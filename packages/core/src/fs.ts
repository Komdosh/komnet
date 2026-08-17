import { access } from "node:fs/promises";

/**
 * Does this path exist?
 *
 * Lives here rather than in `network.ts` because every extracted network domain
 * needs it, and a copy per module is how two of them end up disagreeing about
 * what a missing worktree means.
 */
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
