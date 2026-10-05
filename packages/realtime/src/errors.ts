/**
 * Typed errors for this package.
 *
 * Every error carries a stable machine-readable `code` so a caller can branch
 * without string-matching messages, and an optional `cause` so the underlying
 * transport failure is preserved rather than swallowed.
 */

export type RealtimeErrorCode =
  | "REALTIME_ERROR"
  | "CONNECTION_ERROR"
  | "CONNECTION_CLOSED"
  | "CHANNEL_ERROR"
  | "AUTHORIZATION_ERROR"
  | "AUTHENTICATION_ERROR"
  | "MESSAGE_TOO_LARGE"
  | "CONNECTION_LIMIT";

export class RealtimeError extends Error {
  readonly code: RealtimeErrorCode;

  constructor(code: RealtimeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** A connection could not be registered, is unusable, or was already released. */
export class ConnectionError extends RealtimeError {
  readonly connectionId: string | undefined;

  constructor(
    message: string,
    options?: { connectionId?: string; cause?: unknown; code?: RealtimeErrorCode },
  ) {
    super(options?.code ?? "CONNECTION_ERROR", message, { cause: options?.cause });
    this.connectionId = options?.connectionId;
  }
}

/** The hub was closed, so the operation cannot be served. */
export class ConnectionClosedError extends ConnectionError {
  constructor(message = "RealtimeHub is closed") {
    super(message, { code: "CONNECTION_CLOSED" });
  }
}

/** A channel name was empty, too long, or otherwise unusable. */
export class ChannelError extends RealtimeError {
  readonly channel: string | undefined;

  constructor(message: string, options?: { channel?: string }) {
    super("CHANNEL_ERROR", message);
    this.channel = options?.channel;
  }
}

/** An authentication hook rejected the connection. */
export class AuthenticationError extends RealtimeError {
  constructor(message = "Connection was not authenticated", options?: { cause?: unknown }) {
    super("AUTHENTICATION_ERROR", message, { cause: options?.cause });
  }
}

/** An authorization hook denied the operation. */
export class AuthorizationError extends RealtimeError {
  readonly action: string;

  constructor(action: string, options?: { cause?: unknown }) {
    super("AUTHORIZATION_ERROR", `Not authorized to ${action}`, { cause: options?.cause });
    this.action = action;
  }
}

/** The encoded payload exceeded `maxMessageSize`. */
export class MessageTooLargeError extends RealtimeError {
  readonly size: number;
  readonly limit: number;

  constructor(size: number, limit: number) {
    super(
      "MESSAGE_TOO_LARGE",
      `Message of ${size} bytes exceeds the ${limit} byte limit`,
    );
    this.size = size;
    this.limit = limit;
  }
}

/** A configured capacity limit was reached. */
export class ConnectionLimitError extends RealtimeError {
  readonly limit: number;

  constructor(message: string, limit: number) {
    super("CONNECTION_LIMIT", message);
    this.limit = limit;
  }
}
