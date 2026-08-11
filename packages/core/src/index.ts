/**
 * @kom-net/core — the engine: git transport, room store, change detection,
 * and the secret scanner.
 *
 * Everything here is usable without a daemon; the daemon (ADR 0005) is what
 * gives it a lifecycle and a single-writer guarantee.
 */

export {
  GitError,
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
  FileChange,
  FileChangeStatus,
} from "./git/repo.ts";

export { Layout } from "./layout.ts";

export { RoomStore } from "./room/store.ts";

export {
  SYNC_STATES,
  DEFAULT_CADENCE,
  CadenceController,
  nextState,
  intervalFor,
  failureBackoff,
} from "./sync/cadence.ts";
export type { SyncState, CadencePolicy, CadenceInput } from "./sync/cadence.ts";

export { diffRoomHeads, collectRoomUpdate } from "./sync/detector.ts";
export type {
  RoomChange,
  HeadDiff,
  RoomUpdate,
  Anomaly,
  UnreadableMessage,
} from "./sync/detector.ts";

export { scanForSecrets, hasSecrets, shannonEntropy, describeFindings } from "./scanner/secrets.ts";
export type { SecretRule, SecretFinding, ScanOptions } from "./scanner/secrets.ts";
