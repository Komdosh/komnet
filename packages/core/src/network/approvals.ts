/**
 * The human half of the inbound-work gate.
 *
 * A leaf: it calls nothing back into the network, and tasks and reviews both
 * call it rather than the other way round. Machine-local and never published —
 * a peer can ask for work, and cannot see or satisfy the decision about whether
 * this machine takes it on.
 */

import { ApprovalRequiredError } from "../errors.ts";
import { approvalRequired, originOf } from "../policy.ts";
import type { ApprovalKind, ApprovalRecord, ApprovalStore } from "../approvals.ts";
import type { ResolvedPolicy } from "../policy.ts";

/** What the gate needs from the network, and nothing more. */
export interface ApprovalsContext {
  readonly agentId: string;
  readonly store: ApprovalStore;
  policy(): Promise<ResolvedPolicy>;
}

/**
 * Refuse to take on delegated work until a person has agreed to it.
 *
 * Only claiming is gated, because claiming is the moment this agent commits to
 * doing something for somebody else. Answering a question, reporting progress,
 * and finishing work already accepted are not gated: the policy is about taking
 * on obligations, not about talking, and a gate that fired on every message
 * would be switched off within a day.
 */
export async function requireApproval(
  ctx: ApprovalsContext,
  kind: ApprovalKind,
  roomId: string,
  id: string,
  requester: string,
): Promise<void> {
  const { policy } = await ctx.policy();
  const origin = originOf(requester, ctx.agentId, policy.approvals);
  if (!approvalRequired(origin, policy.approvals)) return;
  if (await ctx.store.has(kind, id)) return;
  throw new ApprovalRequiredError({
    kind,
    id,
    room: roomId,
    requester,
    origin,
    mode: policy.approvals.inboundWork,
  });
}

/**
 * Record that a person approved this agent taking on one piece of work.
 *
 * Local and unpublished. This is the human half of the gate, so it is reachable
 * from the interactive CLI and deliberately not from the MCP tool surface — an
 * agent that could approve its own inbound work would be a gate that gates
 * nothing (ADR 0012 applies the same reasoning to `--as-human`).
 */
export async function approveInboundWork(
  ctx: ApprovalsContext,
  kind: ApprovalKind,
  roomId: string,
  id: string,
  note?: string,
): Promise<ApprovalRecord> {
  return await ctx.store.record({
    kind,
    id,
    room: roomId,
    ...(note === undefined ? {} : { note }),
  });
}

export async function listApprovals(ctx: ApprovalsContext): Promise<ApprovalRecord[]> {
  return await ctx.store.list();
}

export async function revokeApproval(
  ctx: ApprovalsContext,
  kind: ApprovalKind,
  id: string,
): Promise<boolean> {
  return await ctx.store.revoke(kind, id);
}
