import { normalizeLogger, type Logger } from "../logger.js";
import { type Redis as RedisClient } from "ioredis";

/** Command names whose arguments must never be logged. */
const SECRET_COMMANDS = new Set(["auth", "hello"]);

/**
 * Strip credentials before an error reaches a logger.
 *
 * ioredis attaches the failing command to its errors, and for `AUTH` that
 * command's args are the username and the password in plaintext:
 *
 *   { command: { name: "auth", args: ["default", "hunter2-real-secret"] } }
 *
 * Logging the error as-is writes the Redis password to whatever the app logs
 * to, on every failed authentication. The message itself is safe; only the
 * attached command is not, so only that part is replaced.
 */
/** An ioredis error, which carries the failing command alongside the message. */
type CommandError = Error & {
  command?: { name?: unknown; args?: unknown } | null;
};


function redactSensitiveString(value: unknown): unknown {
  if (typeof value === "string") {
    let safe = value;
    safe = safe.replace(/\b([a-z][a-z0-9+.-]*):\/\/[^\s/@]*:[^\s/@]+@/gi, "$1://***@");
    safe = safe.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***");
    return safe;
  }
  if (Array.isArray(value)) {
    return value.map(redactSensitiveString);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = redactSensitiveString((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function redactError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    const redacted = redactSensitiveString(error);
    return redacted;
  }

  const command = (error as CommandError).command;
  const secretCommand = isSecretCommand(command);

  let commandSafe: CommandError["command"] | undefined;
  if (typeof command === "object" && command !== null) {
    if (secretCommand) {
      commandSafe = { ...command, args: "[redacted]" };
    } else if (command.args !== undefined) {
      commandSafe = { ...command, args: redactSensitiveString(command.args) };
    } else {
      commandSafe = { ...command };
    }
  }

  const sanitisedMessage = redactSensitiveString(error.message);
  const messageChanged = sanitisedMessage !== error.message;

  const cause = (error as Error & { cause?: unknown }).cause;
  const redactedCause = cause === undefined ? undefined : redactError(cause);
  const causeChanged = cause !== undefined && redactedCause !== cause;

  // Extra enumerable properties, redacted where possible.
  const extraKeys = Object.keys(error).filter(
    (key) =>
      key !== "name" &&
      key !== "message" &&
      key !== "stack" &&
      key !== "command" &&
      key !== "cause",
  );
  let extraChanged = false;
  const extras: Record<string, unknown> = {};
  for (const key of extraKeys) {
    const originalValue = (error as unknown as Record<string, unknown>)[key];
    const redactedValue = redactSensitiveString(originalValue);
    extras[key] = redactedValue;
    if (!shallowEqual(originalValue, redactedValue)) {
      extraChanged = true;
    }
  }

  const commandChanged = !shallowEqual(command, commandSafe);

  // Nothing sensitive was found: keep the original object so callers (and
  // tests) can rely on identity for a clean error.
  if (!secretCommand && !messageChanged && !causeChanged && !commandChanged && !extraChanged) {
    return error;
  }

  const safe = new Error(sanitisedMessage as string) as CommandError;
  safe.name = error.name;
  safe.stack = error.stack;
  if (commandSafe) {
    safe.command = commandSafe;
  }
  if (cause !== undefined) {
    (safe as Error & { cause?: unknown }).cause = redactedCause;
  }
  for (const key of extraKeys) {
    (safe as unknown as Record<string, unknown>)[key] = extras[key];
  }

  return safe;
}

function isSecretCommand(command: { name?: unknown; args?: unknown } | null | undefined): boolean {
  return (
    typeof command === "object" &&
    command !== null &&
    SECRET_COMMANDS.has(String(command.name).toLowerCase())
  );
}

function shallowEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return a === b;
  }
}

/**
 * Marks a client this function has already wired up.
 *
 * `attachEvents` is exported and `createClient` calls it. A caller reaching for
 * the exported helper on a client from `createClient` would otherwise get a
 * second full set of listeners, logging every connection event twice. BullMQ
 * adds listeners to the same client too, so crossing the default limit of 10
 * and tripping `MaxListenersExceededWarning` should not be something a
 * consumer causes by accident.
 *
 * A global symbol is used so two copies of this package in one dependency tree
 * still recognise a client the other already wired.
 */
const WIRED = Symbol.for("oneunit.redis.eventsAttached");



export interface ErrorClassification {
  kind: "auth" | "connection" | "timeout" | "command" | "unknown";
  retryable: boolean;
  code?: string;
}

export function classifyError(error: unknown): ErrorClassification {
  const redacted = redactError(error);
  const message = redacted instanceof Error ? redacted.message : String(redacted);
  const original = error instanceof Error ? error : undefined;
  const code = (original as { code?: unknown })?.code ? String((original as { code?: unknown }).code) : undefined;

  if (/WRONGPASS|NOAUTH/i.test(message)) {
    return { kind: "auth", retryable: false, code: code ?? "AUTH" };
  }

  if (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket disconnected|connection is closed/i.test(message)
  ) {
    return {
      kind: "connection",
      retryable: code !== "ECONNREFUSED",
      code,
    };
  }

  if (code === "ETIMEDOUT" || /timed? out/i.test(message)) {
    return { kind: "timeout", retryable: true, code };
  }

  if (/READONLY|WRONGTYPE|ERR /i.test(message)) {
    return { kind: "command", retryable: false, code };
  }

  return { kind: "unknown", retryable: false, code };
}

export function isRetryable(error: unknown): boolean {
  return classifyError(error).retryable;
}

export interface ErrorHandlingOptions {
  enabled?: boolean;
  logger?: Logger;
  onError?: (error: unknown, classification: ErrorClassification) => void;
}

export function attachErrorHandling(
  client: RedisClient,
  options: ErrorHandlingOptions = {},
): void {
  if (!options.enabled) {
    return;
  }

  const logger = normalizeLogger(options.logger);

  client.on("error", (err: Error) => {
    const classified = classifyError(err);
    const redacted = redactError(err);

    if (options.onError) {
      options.onError(redacted, classified);
      return;
    }

    logger?.debug?.("redis error classified", {
      kind: classified.kind,
      retryable: classified.retryable,
      err: redacted,
    });
  });
}

export function attachEvents(client: RedisClient, loggerInput?: Logger): void {
  if ((client as unknown as Record<symbol, boolean>)[WIRED]) {
    return;
  }

  Object.defineProperty(client, WIRED, {
    value: true,
    enumerable: false,
  });

  const logger = normalizeLogger(loggerInput);

  client.on("connect", () => {
    logger?.info("redis connect");
  });

  client.on("ready", () => {
    logger?.info("redis ready");
  });

  client.on("reconnecting", (delay: number) => {
    logger?.warn(
      delay ? `redis reconnecting in ${delay}ms` : "redis reconnecting",
    );
  });

  client.on("error", (err: Error) => {
    logger?.error("redis error", { err: redactError(err) });
  });

  client.on("close", () => {
    logger?.info("redis close");
  });
}
