import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { canonicalForm, type Message } from "@komnet/protocol";

import type { AgentCard } from "./agent/card.ts";
import type { AuthenticityMode } from "./net.ts";

const exec = promisify(execFile);

/** Namespace for SSH signatures, per spec §10.1. */
export const SIGNATURE_NAMESPACE = "komnet";

export interface VerificationInput {
  message: Message;
  /** Email on the git commit that added this message file. */
  commitAuthorEmail: string | null;
  /** The author's published card, if the network knows them. */
  card: AgentCard | undefined;
  allowedSignersPath: string | null;
}

export interface Verification {
  verified: boolean;
  /** Why it failed. Surfaced to the operator — never used to drop the message. */
  reason?: string;
}

/**
 * Check a message's claimed author against the network's authenticity mode.
 *
 * A failure is **reported, never dropped** (spec §10). Silently discarding an
 * unverifiable message would let an attacker suppress traffic by making it look
 * malformed, and would make the log lie about what was said.
 */
export async function verifyMessage(
  mode: AuthenticityMode,
  input: VerificationInput,
): Promise<Verification> {
  if (mode === "none") return { verified: true };

  if (mode === "git") return verifyGitAuthor(input);

  // signed: a cryptographic signature is required, so a missing one fails.
  const signature = input.message.header.sig;
  if (signature === undefined) {
    return {
      verified: false,
      reason: "network requires signed messages, but this one has no signature",
    };
  }
  if (input.allowedSignersPath === null) {
    return {
      verified: false,
      reason: "no .komnet/allowed_signers on this network to verify against",
    };
  }
  return await verifySshSignature(input.message, signature, input.allowedSignersPath);
}

/**
 * `git` mode: the commit author must be the agent the message claims to be from.
 *
 * The binding lives on the agent card (`git_author`), which each agent publishes
 * for itself — so this catches one member writing a message as another, which is
 * the realistic forgery inside a network where everyone can already push.
 */
export function verifyGitAuthor(input: VerificationInput): Verification {
  const claimed = input.message.header.from;

  if (input.card === undefined) {
    return { verified: false, reason: `no published agent card for '${claimed}'` };
  }
  const expected = input.card.gitAuthor?.email;
  if (expected === undefined || expected === "") {
    // The card predates git-author binding. Not a forgery signal on its own, so
    // say precisely that rather than crying wolf.
    return {
      verified: false,
      reason: `agent card for '${claimed}' declares no git author to check against`,
    };
  }
  if (input.commitAuthorEmail === null) {
    return { verified: false, reason: "could not determine the commit author" };
  }
  if (input.commitAuthorEmail.toLowerCase() !== expected.toLowerCase()) {
    return {
      verified: false,
      reason: `committed by ${input.commitAuthorEmail}, but claims to be from '${claimed}' (${expected})`,
    };
  }
  return { verified: true };
}

/** Verify an SSH signature over the canonical form, via `ssh-keygen -Y verify`. */
export async function verifySshSignature(
  message: Message,
  signature: string,
  allowedSignersPath: string,
): Promise<Verification> {
  const dir = await mkdtemp(join(tmpdir(), "komnet-verify-"));
  try {
    const sigPath = join(dir, "sig");
    await writeFile(sigPath, signature.endsWith("\n") ? signature : `${signature}\n`, "utf8");

    // The identity ssh-keygen matches in allowed_signers. The card's git email
    // is the same identity used for signing.
    const identity = message.header.from;
    await exec(
      "ssh-keygen",
      [
        "-Y",
        "verify",
        "-f",
        allowedSignersPath,
        "-I",
        identity,
        "-n",
        SIGNATURE_NAMESPACE,
        "-s",
        sigPath,
      ],
      { input: canonicalForm(message) } as never,
    );
    return { verified: true };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    return {
      verified: false,
      reason: `signature did not verify${stderr === "" ? "" : `: ${stderr.trim()}`}`,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Sign a message's canonical form. Returns null when no signing key is available. */
export async function signMessage(message: Message, keyPath: string): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "komnet-sign-"));
  try {
    const payloadPath = join(dir, "payload");
    await writeFile(payloadPath, canonicalForm(message), "utf8");
    await exec("ssh-keygen", ["-Y", "sign", "-f", keyPath, "-n", SIGNATURE_NAMESPACE, payloadPath]);
    const { readFile } = await import("node:fs/promises");
    return await readFile(`${payloadPath}.sig`, "utf8");
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
