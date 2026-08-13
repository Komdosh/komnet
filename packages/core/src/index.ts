/**
 * @komnet/core — the engine: git transport, room store, change detection,
 * and the secret scanner.
 *
 * Everything here is usable without a daemon; the daemon (ADR 0005) is what
 * gives it a lifecycle and a single-writer guarantee.
 */

export {
  ApprovalRequiredError,
  describeError,
  GitError,
  GitNotFoundError,
  NotSubscribedError,
  PushExhaustedError,
  SecretDetectedError,
  InvariantViolationError,
} from "./errors.ts";

export { GitRunner, NETWORK_TIMEOUT_MS } from "./git/runner.ts";
export type { GitRunOptions, GitResult } from "./git/runner.ts";

export { Repo, backoffDelay } from "./git/repo.ts";
export type {
  PushOptions,
  PushResult,
  RefEntry,
  RemoteHeads,
  FileChange,
  FileChangeStatus,
} from "./git/repo.ts";

export { Layout } from "./layout.ts";

export {
  APPROVAL_MODES,
  DEFAULT_ACTIVATION_POLICY,
  DEFAULT_LOCAL_POLICY,
  approvalRequired,
  isApprovalMode,
  loadLocalPolicy,
  originOf,
  parseLocalPolicy,
  policySearchPath,
  policyTemplate,
} from "./policy.ts";
export type {
  ActivationPolicy,
  ApprovalMode,
  ApprovalPolicy,
  LocalPolicy,
  ResolvedPolicy,
  WorkOrigin,
} from "./policy.ts";

export { APPROVAL_KINDS, ApprovalStore } from "./approvals.ts";
export type { ApprovalKind, ApprovalRecord } from "./approvals.ts";

export { currentHolder, reduceClaims } from "./room/claims.ts";
export type { ClaimStatus } from "./room/claims.ts";
export { RoomStore } from "./room/store.ts";
export { assessReviewDiscussionPressure, assessThreadPressure } from "./room/pressure.ts";
export type { ThreadPressure } from "./room/pressure.ts";
export { reduceReviewTasks } from "./review/tasks.ts";
export type { InvalidReviewEvent, ReviewTaskStatus } from "./review/tasks.ts";
export { activeTaskThreads, reduceTaskDetail, reduceTasks } from "./task/tasks.ts";
export type {
  InvalidTaskEvent,
  TaskDetail,
  TaskEventView,
  TaskHealth,
  TaskStatus,
} from "./task/tasks.ts";
export { AGENDA_RELATIONS, buildAgenda } from "./task/agenda.ts";
export type {
  Agenda,
  AgendaCounts,
  AgendaEntry,
  AgendaOptions,
  AgendaRelation,
  RoomTasks,
} from "./task/agenda.ts";
export { ReviewRepositoryResolver, canonicalRepositoryFromRemote } from "./review/repository.ts";
export type {
  PreparedReviewRepository,
  ReleasedReviewRepository,
  ReviewRevisionRelation,
} from "./review/repository.ts";

export {
  SYNC_STATES,
  DEFAULT_CADENCE,
  CadenceController,
  nextState,
  intervalFor,
  failureBackoff,
  steadyPollDelay,
} from "./sync/cadence.ts";
export type { SyncState, CadencePolicy, CadenceInput } from "./sync/cadence.ts";

export { diffRoomHeads, collectRoomUpdate } from "./sync/detector.ts";
export { shouldDeliverMessage } from "./sync/routing.ts";
export type {
  RoomChange,
  HeadDiff,
  RoomUpdate,
  Anomaly,
  UnreadableMessage,
} from "./sync/detector.ts";

export { scanForSecrets, hasSecrets, shannonEntropy, describeFindings } from "./scanner/secrets.ts";
export type { SecretRule, SecretFinding, ScanOptions } from "./scanner/secrets.ts";

export {
  CONFIG_VERSION,
  defaultIdentity,
  emptyConfig,
  loadConfig,
  saveConfig,
  resolveNetwork,
  DEFAULT_LOCAL_REVIEW_POLICY,
  isGitRemoteName,
} from "./config.ts";
export type {
  AgentIdentity,
  NetworkConfig,
  KomnetConfig,
  LocalRepositoryConfig,
  LocalReviewPolicy,
} from "./config.ts";

export { StateDb } from "./state.ts";
export type { InboxItem, InboxQuery } from "./state.ts";

export { FileLock } from "./lock.ts";
export type { LockOptions } from "./lock.ts";

export {
  createRoomConfig,
  parseRoomConfig,
  serializeRoomConfig,
  DEFAULT_ROOM_POLICY,
  DEFAULT_ROOM_RETENTION,
} from "./room/config.ts";
export type { RoomConfig, RoomPolicy, RoomRetention } from "./room/config.ts";

export {
  cardFromIdentity,
  liveSessions,
  observedPresenceStatus,
  observedPresenceWithActivity,
  reconcileSessions,
  SESSION_STALE_AFTER_MS,
  parseAgentCard,
  PRESENCE_STALE_AFTER_MS,
  serializeAgentCard,
} from "./agent/card.ts";
export type { AgentCard, PresenceSession, PresenceStatus } from "./agent/card.ts";

export {
  parseAgentProfile,
  profileFromIdentity,
  sameAgentProfile,
  serializeAgentProfile,
} from "./agent/profile.ts";
export type {
  AgentDirectoryEntry,
  AgentProfile,
  AgentProfileEnvironment,
  AgentProfileUpdate,
  AgentRuntimeEnvironment,
} from "./agent/profile.ts";

export { parseReadReceipt, serializeReadReceipt } from "./agent/receipt.ts";
export type { ReadReceipt } from "./agent/receipt.ts";

export { Network, MAX_WAIT_MS, MIN_WAIT_MS, clampWaitMs } from "./network.ts";
export type {
  SendInput,
  SyncReport,
  RoomInfo,
  NetworkStatus,
  TransportHealth,
  AnswerOptions,
  HumanConfirmationRequest,
  ReviewRequestInput,
  ReviewUpdateInput,
  TaskCreateInput,
  TaskUpdateInput,
  HandshakeInput,
  HandshakePeer,
  HandshakeResult,
  PresenceRow,
  DiscoveredMention,
  WaitForInboxOptions,
  WaitForInboxResult,
} from "./network.ts";

export {
  AUTHENTICITY_MODES,
  DEFAULT_MANIFEST,
  parseNetManifest,
  serializeNetManifest,
} from "./net.ts";
export type { NetManifest, AuthenticityMode } from "./net.ts";

export {
  verifyMessage,
  verifyGitAuthor,
  verifySshSignature,
  signMessage,
  SIGNATURE_NAMESPACE,
} from "./authenticity.ts";
export type { Verification, VerificationInput } from "./authenticity.ts";

export { Sealer, DEFAULT_SEAL_POLICY } from "./seal/sealer.ts";
export type { SealPolicy, SealDecision, SealResult } from "./seal/sealer.ts";
export { renderDigest, renderDecision } from "./seal/digest.ts";
export type { DigestInput } from "./seal/digest.ts";
