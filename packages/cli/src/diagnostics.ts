/**
 * Turning a git transport failure into the one sentence a person can act on.
 *
 * These run at the worst moment — someone's push just failed and they are
 * already annoyed — so the quality of the sentence is the whole feature. They
 * live here rather than in `main.ts` because they are pure, they are the part
 * most worth testing, and a unit test for them should not have to import the
 * entire CLI to reach them.
 */

import { describeError, firstMeaningfulLine } from "@komnet/core";

/**
 * What git actually said, without the flags komnet passed to get there.
 *
 * `git -c protocol.version=2 -c core.quotePath=false … failed (128): Permission
 * denied (publickey)` is a sentence about komnet's own invocation wrapped
 * around a sentence about the user's SSH agent. Only the second one is news.
 *
 * `fatal: Could not read from remote repository.` is dropped for the same
 * reason: git prints it above the real cause on every transport failure, so
 * leading with it tells the user their remote is unreachable — which they knew
 * — instead of why.
 */
export function conciseGitFailure(error: unknown): string {
  const full = describeError(error);
  const detail = /failed \(\d+\): ([\s\S]+)$/.exec(full)?.[1] ?? full;
  return (firstMeaningfulLine(detail) ?? detail).trim().slice(0, 160);
}

/**
 * The `user@host` an SSH-style git remote authenticates as, if it is one.
 *
 * Used to print a probe the user can paste — `ssh -T git@github.com` — so the
 * next step after an auth failure is a command rather than a search. Returns
 * null for https and local paths, which have no SSH identity to test.
 */
export function sshHostOf(remote: string): string | null {
  const scp = /^([^/]+@[^:/]+):/.exec(remote);
  if (scp !== null) return scp[1] ?? null;
  const url = /^ssh:\/\/([^/]+)\//.exec(remote);
  return url === null ? null : (url[1] ?? null);
}
