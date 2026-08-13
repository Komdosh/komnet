/**
 * @komnet/protocol — the komnet wire contract in executable form.
 *
 * Deliberately dependency-light and side-effect-free: a third party should be
 * able to implement a compatible client by reading this package alongside
 * `spec/komnet-protocol-v1.md`.
 */
export { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, isSupportedVersion } from "./version.ts";

export {
  ProtocolError,
  MalformedMessageError,
  UnsupportedVersionError,
  InvalidIdentifierError,
} from "./errors.ts";

export {
  REVIEW_TASK_STATES,
  TERMINAL_REVIEW_TASK_STATES,
  REVIEW_WIRE_KEYS,
  ReviewTransitionError,
  createReviewTask,
  parseReviewTask,
  reviewTaskToWire,
  isReviewWireKey,
  isReviewTaskState,
  isCanonicalRepositoryId,
  isTerminalReviewTaskState,
  assertCanonicalRepositoryId,
  assertInitialReviewTask,
  assertReviewTransition,
} from "./review.ts";
export type { ReviewTask, ReviewTaskState, NewReviewTaskInput } from "./review.ts";

export {
  TASK_STATES,
  TASK_ACTIONS,
  TASK_UPDATE_ACTIONS,
  TERMINAL_TASK_STATES,
  TASK_WIRE_KEYS,
  DEFAULT_TASK_STALE_AFTER_SECONDS,
  TaskTransitionError,
  createTask,
  parseTask,
  taskToWire,
  isTaskWireKey,
  isTaskState,
  isTaskAction,
  isTaskUpdateAction,
  isTerminalTaskState,
  assertInitialTask,
  assertTaskTransition,
} from "./task.ts";
export type { Task, TaskState, TaskAction, TaskUpdateAction, NewTaskInput } from "./task.ts";

export { ulid, isUlid, ulidTime, compareUlid, ULID_LENGTH, MAX_ULID_TIME } from "./ids.ts";

export { isRoomId, isAgentId, assertRoomId, assertAgentId, slugify } from "./identifiers.ts";

export {
  MESSAGE_KINDS,
  NEEDS_VALUES,
  PRIORITIES,
  AUTHOR_KINDS,
  MENTION_ROOM,
  HANDSHAKE_TAG,
  HANDSHAKE_ACK_TAG,
  splitFrontmatter,
  parseMessage,
  serializeMessage,
  canonicalForm,
  createMessage,
  isThreadRoot,
  isAddressedTo,
} from "./message.ts";
export type {
  Message,
  MessageHeader,
  MessageKind,
  Needs,
  Priority,
  AuthorKind,
  NewMessageInput,
} from "./message.ts";

export {
  NET_MANIFEST_PATH,
  POLICY_PATH,
  ALLOWED_SIGNERS_PATH,
  MAIN_REF,
  ROOM_REF_GLOB,
  ULID_TAIL_LENGTH,
  roomRef,
  roomIdFromRef,
  roomDir,
  roomConfigPath,
  messageDir,
  messagePath,
  messageFilename,
  compactTimestamp,
  parseMessagePath,
  isMessagePath,
  digestPath,
  decisionPath,
  receiptPath,
  agentCardPath,
  agentProfilePath,
  sealLockPath,
  sealTransactionPath,
  mayModify,
} from "./paths.ts";
export type { ParsedMessagePath } from "./paths.ts";

export { compareMessages, threadOrder, groupByThread } from "./ordering.ts";

export {
  CLAIM_ACTIONS,
  CLAIM_WIRE_KEYS,
  DEFAULT_CLAIM_TTL_SECONDS,
  claimToWire,
  createClaim,
  isClaimAction,
  isResourceName,
  parseClaim,
} from "./claim.ts";
export type { Claim, ClaimAction } from "./claim.ts";
