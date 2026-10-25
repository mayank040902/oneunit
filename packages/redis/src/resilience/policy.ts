import {
  type FallbackPolicy,
  type ResilienceCommand,
  type ResilienceOperation,
} from "./types.js";

/**
 * Commands that are never eligible for fallback buffering because replaying
 * them blindly could corrupt state or violate safety guarantees.
 *
 * Counters (INCR/DECR) are non-idempotent: if Redis applied the increment but
 * the response was lost, replaying would double-apply it.
 * Locks and leases carry fencing/safe-release semantics the engine cannot
 * reproduce.
 * Transactions bundle dependent commands; partial replay breaks atomicity.
 */
const NEVER_BUFFER = new Set<ResilienceCommand>([
  "incr",
  "incrby",
  "decr",
  "decrby",
]);

const SUPPORTED_COMMANDS = new Set<ResilienceCommand>([
  "get", "set", "setex", "setnx", "del", "expire", "ttl", "exists",
  "sadd", "smembers", "srem", "hset", "hget", "hdel", "incr", "incrby",
  "decr", "decrby", "getset",
]);

/**
 * Default fallback policy per command. Unknown or non-idempotent commands
 * reject by default.
 */
function defaultPolicy(command: ResilienceCommand): FallbackPolicy {
  if (!SUPPORTED_COMMANDS.has(command) || NEVER_BUFFER.has(command)) {
    return "reject";
  }
  return "buffer";
}

/**
 * Classifies an operation against the fallback policy and returns whether it
 * may be buffered, along with a reason when it cannot.
 */
export function classifyOperation(
  operation: ResilienceOperation,
): {
  allowed: boolean;
  policy: FallbackPolicy;
  reason?: string;
} {
  const explicit = operation.policy;
  if (explicit !== undefined) {
    return { allowed: explicit === "buffer", policy: explicit };
  }

  const policy = defaultPolicy(operation.command);
  return {
    allowed: policy === "buffer",
    policy,
    reason: policy === "reject"
      ? `Command "${operation.command}" is not eligible for fallback buffering`
      : undefined,
  };
}

/**
 * Whether a command is idempotent when replayed. Idempotent commands may be
 * safely retried after an ambiguous outcome; non-idempotent commands must not
 * be blindly repeated.
 */
export function isIdempotent(command: ResilienceCommand): boolean {
  const nonIdempotent = new Set(["incr", "incrby", "decr", "decrby"]);
  return !nonIdempotent.has(command);
}

/**
 * Whether a command mutates state (a write) versus a read. Write semantics
 * drive ordering and dedup requirements during recovery.
 */
export function isWrite(command: ResilienceCommand): boolean {
  const reads = new Set(["get", "exists", "ttl", "hget", "smembers"]);
  return !reads.has(command);
}

/**
 * Validate an operation before admission. Throws on structural problems;
 * policy rejections are returned, not thrown.
 */
export function validateOperation(operation: ResilienceOperation): void {
  if (!operation.id || typeof operation.id !== "string") {
    throw new Error("operation id is required");
  }

  if (!operation.key || typeof operation.key !== "string") {
    throw new Error("operation key is required");
  }

  if (
    operation.ttlSeconds !== undefined &&
    (!Number.isFinite(operation.ttlSeconds) || operation.ttlSeconds <= 0)
  ) {
    throw new Error("ttlSeconds must be a positive finite number");
  }

  if (
    operation.expiresAt !== undefined &&
    (!Number.isFinite(operation.expiresAt) || operation.expiresAt <= 0)
  ) {
    throw new Error("expiresAt must be a positive finite timestamp");
  }
}
