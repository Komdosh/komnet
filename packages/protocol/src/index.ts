/**
 * @kom-net/protocol — the kom-net wire contract in executable form.
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

export { ulid, isUlid, ulidTime, compareUlid, ULID_LENGTH, MAX_ULID_TIME } from "./ids.ts";

export { isRoomId, isAgentId, assertRoomId, assertAgentId, slugify } from "./identifiers.ts";

export {
  MESSAGE_KINDS,
  NEEDS_VALUES,
  PRIORITIES,
  AUTHOR_KINDS,
  MENTION_ROOM,
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
  sealLockPath,
  mayModify,
} from "./paths.ts";
export type { ParsedMessagePath } from "./paths.ts";

export { compareMessages, threadOrder, groupByThread } from "./ordering.ts";
