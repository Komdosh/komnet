export { Daemon } from "./daemon.ts";
export type { DaemonOptions } from "./daemon.ts";

export { DaemonClient, DaemonUnavailableError, DaemonRequestError } from "./client.ts";

export { openBackend } from "./backend.ts";
export type { Backend, OpenBackendOptions } from "./backend.ts";

export { SyncLoop } from "./loop.ts";
export type { SyncLoopOptions } from "./loop.ts";

export { createNotifier, shouldNotify, sanitize, NOTIFIER_KINDS } from "./notify.ts";
export type { Notifier, NotifierKind, Notification } from "./notify.ts";

export {
  METHODS,
  DAEMON_ONLY_METHODS,
  IPC_PROTOCOL_VERSION,
  LineFramer,
  encode,
  isMethod,
  isDaemonOnlyMethod,
} from "./protocol.ts";
export type {
  Method,
  DaemonOnlyMethod,
  DirectMethod,
  IpcRequest,
  IpcResponse,
} from "./protocol.ts";

export {
  detectSupervisor,
  installService,
  uninstallService,
  isServiceInstalled,
  renderUnit,
  unitPath,
  SERVICE_LABEL,
} from "./supervisor.ts";
export type { SupervisorKind, InstallResult } from "./supervisor.ts";
