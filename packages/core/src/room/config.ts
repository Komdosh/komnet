import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { assertRoomId } from "@komnet/protocol";

export interface RoomPolicy {
  /**
   * Whether a decision's `decided_by` must name a human principal.
   *
   * **Declared, carried on the wire, and enforced by nothing here.** The spec
   * states the rule (§9) and this implementation has never applied it, so a
   * room setting it true gets no gating. It is left in place because removing a
   * wire field is a protocol change and a conforming implementation may honour
   * it — but it defaults to false now rather than asserting a constraint that
   * does not hold.
   */
  decisionsRequireHuman: boolean;
  replyBudget: number;
}

export interface RoomRetention {
  windowDays: number;
  windowMessages: number;
  sealMinIntervalHours: number;
}

export interface RoomConfig {
  v: number;
  id: string;
  title: string;
  purpose: string;
  status: "open" | "closed";
  created: string;
  createdBy: string;
  /** Advisory only — the authoritative answer is each agent's subscription. */
  participants: string[];
  policy: RoomPolicy;
  retention: RoomRetention;
}

export const DEFAULT_ROOM_POLICY: RoomPolicy = {
  // Advisory and, in this implementation, unenforced — see `RoomPolicy`.
  decisionsRequireHuman: false,
  // Consecutive agent replies before the next one is parked for a person.
  //
  // Six ended a genuine two-agent exchange right where it became productive:
  // question, answer, clarification, answer, refinement, answer is already six.
  // The budget exists to stop a runaway loop, not to cap a conversation, and a
  // parked thread that did not need a person teaches everyone to ignore the
  // marker. Twelve still terminates; it just does not fire on ordinary work.
  replyBudget: 12,
};

export const DEFAULT_ROOM_RETENTION: RoomRetention = {
  windowDays: 30,
  windowMessages: 500,
  sealMinIntervalHours: 24,
};

export function createRoomConfig(init: {
  id: string;
  title?: string;
  purpose?: string;
  createdBy: string;
  participants?: string[];
  /** Consecutive agent replies allowed before a thread parks for a person. */
  replyBudget?: number;
}): RoomConfig {
  assertRoomId(init.id);
  return {
    v: 1,
    id: init.id,
    title: init.title ?? init.id,
    purpose: init.purpose ?? "",
    status: "open",
    created: new Date().toISOString(),
    createdBy: init.createdBy,
    participants: init.participants ?? [init.createdBy],
    policy: {
      ...DEFAULT_ROOM_POLICY,
      ...(init.replyBudget === undefined
        ? {}
        : { replyBudget: Math.max(1, Math.floor(init.replyBudget)) }),
    },
    retention: { ...DEFAULT_ROOM_RETENTION },
  };
}

/** Wire form is snake_case for readability in a git web UI. */
export function serializeRoomConfig(room: RoomConfig): string {
  return stringifyYaml(
    {
      v: room.v,
      id: room.id,
      title: room.title,
      purpose: room.purpose,
      status: room.status,
      created: room.created,
      created_by: room.createdBy,
      participants: room.participants,
      policy: {
        decisions_require_human: room.policy.decisionsRequireHuman,
        reply_budget: room.policy.replyBudget,
      },
      retention: {
        window: { days: room.retention.windowDays, messages: room.retention.windowMessages },
        seal: { min_interval_hours: room.retention.sealMinIntervalHours },
      },
    },
    { lineWidth: 0 },
  );
}

export function parseRoomConfig(raw: string): RoomConfig {
  const y = parseYaml(raw) as Record<string, unknown> | null;
  if (y === null || typeof y !== "object") throw new Error("room.yaml is not a YAML mapping");

  const policy = (y["policy"] ?? {}) as Record<string, unknown>;
  const retention = (y["retention"] ?? {}) as Record<string, unknown>;
  const window = (retention["window"] ?? {}) as Record<string, unknown>;
  const seal = (retention["seal"] ?? {}) as Record<string, unknown>;
  const id = String(y["id"] ?? "");
  assertRoomId(id);

  return {
    v: Number(y["v"] ?? 1),
    id,
    title: String(y["title"] ?? id),
    purpose: String(y["purpose"] ?? ""),
    status: y["status"] === "closed" ? "closed" : "open",
    created: String(y["created"] ?? new Date(0).toISOString()),
    createdBy: String(y["created_by"] ?? "unknown"),
    participants: Array.isArray(y["participants"]) ? (y["participants"] as string[]) : [],
    policy: {
      decisionsRequireHuman: policy["decisions_require_human"] !== false,
      replyBudget: Number(policy["reply_budget"] ?? DEFAULT_ROOM_POLICY.replyBudget),
    },
    retention: {
      windowDays: Number(window["days"] ?? DEFAULT_ROOM_RETENTION.windowDays),
      windowMessages: Number(window["messages"] ?? DEFAULT_ROOM_RETENTION.windowMessages),
      sealMinIntervalHours: Number(
        seal["min_interval_hours"] ?? DEFAULT_ROOM_RETENTION.sealMinIntervalHours,
      ),
    },
  };
}
