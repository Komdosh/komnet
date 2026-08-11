/**
 * Protocol-level failures. These are all "the bytes on disk do not describe a
 * valid message" errors — transport and git failures live in @kom-net/core.
 */
export class ProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProtocolError";
    this.code = code;
  }
}

export class MalformedMessageError extends ProtocolError {
  /** Path or filename the bad content came from, when known. */
  readonly source: string | undefined;

  constructor(message: string, source?: string, options?: { cause?: unknown }) {
    super("MALFORMED_MESSAGE", message, options);
    this.name = "MalformedMessageError";
    this.source = source;
  }
}

export class UnsupportedVersionError extends ProtocolError {
  readonly version: number;

  constructor(version: number) {
    super(
      "UNSUPPORTED_VERSION",
      `message declares protocol version ${String(version)}, which this build cannot read; upgrade kom-net`,
    );
    this.name = "UnsupportedVersionError";
    this.version = version;
  }
}

export class InvalidIdentifierError extends ProtocolError {
  constructor(kind: string, value: string, rule: string) {
    super("INVALID_IDENTIFIER", `invalid ${kind} ${JSON.stringify(value)}: must match ${rule}`);
    this.name = "InvalidIdentifierError";
  }
}
