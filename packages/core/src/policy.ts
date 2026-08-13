import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

import { isAgentId } from "@komnet/protocol";

import type { Layout } from "./layout.ts";

/**
 * Machine-local operating policy — the file a person edits by hand.
 *
 * Deliberately NOT part of `config.yaml`. That file is rewritten by komnet
 * itself on `room join`, `room leave`, `repo map`, and every daemon
 * subscription change, and rewriting round-trips through the YAML serialiser —
 * so comments, ordering, and anything else a human put there are destroyed the
 * next time a room is joined. A file people are asked to edit must be one the
 * tool never writes.
 *
 * Also distinct from the two shared policies, which are a different thing
 * entirely: `.komnet/policy.yaml` **inside the transport repository** is
 * network-wide and applies to everyone (spec §8), and `room.yaml` carries
 * per-room policy. Both are shared state, agreed by the team. This one is
 * local: it answers "how must MY agent behave on MY machine", which is nobody
 * else's decision — and, critically, is not something a remote peer can set.
 */

/** When a person must approve before this agent takes on delegated work. */
export const APPROVAL_MODES = ["never", "remote", "always"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** Where a piece of delegated work came from, as decided by local data only. */
export type WorkOrigin = "local" | "remote";

export interface ApprovalPolicy {
  /**
   * Approval required before claiming work someone delegated.
   *
   * - `never` — take any work without asking. Fully autonomous.
   * - `remote` — ask only for work delegated from another machine. Default.
   * - `always` — ask even for work this agent or a local agent created.
   */
  inboundWork: ApprovalMode;
  /**
   * Agents whose delegations count as `local`.
   *
   * This agent is always local and never needs listing. Everything else is
   * remote until named here, and it is named **here**, in a local file,
   * rather than derived from the agent card: a card is written by the machine
   * it describes, so a peer could declare itself local and walk through the
   * gate that exists to keep its requests under a person's control.
   */
  localAgents: string[];
}

export interface LocalPolicy {
  v: number;
  approvals: ApprovalPolicy;
}

export const DEFAULT_LOCAL_POLICY: LocalPolicy = {
  v: 1,
  approvals: {
    // Work delegated from another machine is the case a person should see.
    // Work this agent created for itself is not a delegation at all, and
    // pausing on it would make the gate fire constantly and get switched off.
    inboundWork: "remote",
    localAgents: [],
  },
};

export interface ResolvedPolicy {
  policy: LocalPolicy;
  /** Files that contributed, nearest last. Empty means every value is default. */
  sources: string[];
}

function fail(source: string, message: string): never {
  throw new Error(`${source}: ${message}`);
}

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

/**
 * Parse a policy file, refusing anything it does not understand.
 *
 * Unknown keys are an error rather than a shrug. This file exists so a person
 * can constrain an agent; silently ignoring a misspelled key would leave them
 * believing a limit is in force when it is not, which is worse than no file.
 */
export function parseLocalPolicy(raw: string, source: string): Partial<LocalPolicy> {
  const parsed: unknown = parseYaml(raw);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(source, "policy must be a YAML mapping");
  }
  const root = parsed as Record<string, unknown>;

  for (const key of Object.keys(root)) {
    if (key !== "v" && key !== "approvals") {
      fail(source, `unknown top-level key '${key}'; known keys: v, approvals`);
    }
  }
  if (root["v"] !== undefined && root["v"] !== 1) {
    fail(source, `unsupported policy version ${String(root["v"])}; this build understands v: 1`);
  }

  const approvalsValue = root["approvals"];
  if (approvalsValue === undefined) return {};
  if (
    approvalsValue === null ||
    typeof approvalsValue !== "object" ||
    Array.isArray(approvalsValue)
  )
    fail(source, "'approvals' must be a mapping");
  const approvals = approvalsValue as Record<string, unknown>;

  for (const key of Object.keys(approvals)) {
    if (key !== "inboundWork" && key !== "localAgents") {
      fail(source, `unknown key 'approvals.${key}'; known keys: inboundWork, localAgents`);
    }
  }

  const result: Partial<ApprovalPolicy> = {};
  const mode = approvals["inboundWork"];
  if (mode !== undefined) {
    if (!isApprovalMode(mode)) {
      fail(
        source,
        `approvals.inboundWork must be one of: ${APPROVAL_MODES.join(", ")} (got ${JSON.stringify(mode)})`,
      );
    }
    result.inboundWork = mode;
  }

  const local = approvals["localAgents"];
  if (local !== undefined) {
    if (!Array.isArray(local)) fail(source, "approvals.localAgents must be a list of agent ids");
    const ids: string[] = [];
    for (const entry of local) {
      if (typeof entry !== "string" || !isAgentId(entry)) {
        fail(
          source,
          `approvals.localAgents contains an invalid agent id: ${JSON.stringify(entry)}`,
        );
      }
      if (!ids.includes(entry)) ids.push(entry);
    }
    result.localAgents = ids;
  }

  return Object.keys(result).length === 0 ? {} : { approvals: result as ApprovalPolicy };
}

/**
 * Where policy is read from, nearest last.
 *
 * A per-agent home is `<machine-root>/agents/<id>`, and an agent running there
 * has that home as its whole world. Without the machine-root lookup a person
 * who set a policy once would find it silently ignored by every agent they
 * provisioned, which is exactly the failure this file is meant to prevent.
 */
export function policySearchPath(layout: Layout): string[] {
  const home = join(layout.root, "policy.yaml");
  const parent = dirname(layout.root);
  const isAgentHome = basename(parent) === "agents" && isAgentId(basename(layout.root));
  if (!isAgentHome) return [home];
  return [join(dirname(parent), "policy.yaml"), home];
}

/** Load and merge the policy files that apply to this home. */
export async function loadLocalPolicy(layout: Layout): Promise<ResolvedPolicy> {
  const policy: LocalPolicy = {
    v: DEFAULT_LOCAL_POLICY.v,
    approvals: { ...DEFAULT_LOCAL_POLICY.approvals },
  };
  const sources: string[] = [];

  for (const path of policySearchPath(layout)) {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const parsed = parseLocalPolicy(raw, path);
    sources.push(path);
    if (parsed.approvals?.inboundWork !== undefined) {
      policy.approvals.inboundWork = parsed.approvals.inboundWork;
    }
    if (parsed.approvals?.localAgents !== undefined) {
      policy.approvals.localAgents = parsed.approvals.localAgents;
    }
  }

  return { policy, sources };
}

/**
 * Decide where a delegation came from, using only what this machine knows.
 *
 * `self` is local because creating your own task is not a delegation. Every
 * other agent is remote until a person lists it, for the reason stated on
 * `localAgents`.
 */
export function originOf(creator: string, self: string, policy: ApprovalPolicy): WorkOrigin {
  if (creator === self) return "local";
  return policy.localAgents.includes(creator) ? "local" : "remote";
}

/** Whether taking on this delegation needs a person first. */
export function approvalRequired(origin: WorkOrigin, policy: ApprovalPolicy): boolean {
  if (policy.inboundWork === "never") return false;
  if (policy.inboundWork === "always") return true;
  return origin === "remote";
}

/** A commented starting point, written only by `komnet policy --init`. */
export function policyTemplate(): string {
  return `# komnet — machine-local policy
#
# komnet reads this file and never rewrites it, so comments and ordering
# survive. It is local to this machine: it constrains YOUR agent and is not
# visible to, or settable by, anyone else on the network.
#
# Not to be confused with:
#   .komnet/policy.yaml INSIDE the transport repo — network-wide, shared
#   rooms/<id>/room.yaml                          — per-room, shared
v: 1

approvals:
  # Must a person approve before this agent takes on work someone delegated?
  #
  #   never   take any work without asking — fully autonomous
  #   remote  ask only for work delegated from another machine  (default)
  #   always  ask for everything, including work you created yourself
  #
  # Applies to claiming a task and claiming a delegated repository review.
  # Answering questions, sending messages, and reporting progress are never
  # gated: the gate is about committing to do work, not about talking.
  inboundWork: remote

  # Agents whose delegations count as local, so they are not gated under
  # 'remote'. This agent is always local and does not need listing.
  #
  # Listed HERE rather than detected, on purpose: an agent card is written by
  # the machine it describes, so a peer could otherwise declare itself local
  # and walk straight through the gate.
  localAgents: []
`;
}
