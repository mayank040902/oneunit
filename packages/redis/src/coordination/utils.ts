/* eslint-disable */
import { Redis } from "ioredis";
import { buildKey } from "../features/core-helpers.js";
import { normalizeLogger, type Logger } from "../logger.js";
import type { CoordinationClientConfig } from "./types.js";
import { CoordinationConfigError } from "./errors.js";

const DEFAULT_KEY_PREFIX = "coord";
const DEFAULT_LEASE_MS = 30000;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RETRY_INTERVAL_MS = 100;

export function createCoordinationKeyBuilder(prefix?: string) {
  const basePrefix = prefix ?? DEFAULT_KEY_PREFIX;
  
  return {
    lock: (resource: string) => buildKey(basePrefix, `{${resource}}`, "lock"),
    lockFencing: (resource: string) => buildKey(basePrefix, `{${resource}}`, "lock", "fencing"),
    semaphore: (resource: string) => buildKey(basePrefix, `{${resource}}`, "semaphore"),
    semaphoreFencing: (resource: string) => buildKey(basePrefix, `{${resource}}`, "semaphore", "fencing"),
    singleFlight: (key: string) => buildKey(basePrefix, `{${key}}`, "singleflight"),
    singleFlightFencing: (key: string) => buildKey(basePrefix, `{${key}}`, "singleflight", "fencing"),
    leaderElection: (resource: string) => buildKey(basePrefix, `{${resource}}`, "leader"),
    leaderElectionFencing: (resource: string) => buildKey(basePrefix, `{${resource}}`, "leader", "fencing"),
    jobClaim: (jobId: string) => buildKey(basePrefix, `{${jobId}}`, "job"),
    jobClaimFencing: (jobId: string) => buildKey(basePrefix, `{${jobId}}`, "job", "fencing"),
    lease: (resource: string) => buildKey(basePrefix, `{${resource}}`, "lease"),
    leaseFencing: (resource: string) => buildKey(basePrefix, `{${resource}}`, "lease", "fencing"),
    barrier: (barrierId: string) => buildKey(basePrefix, `{${barrierId}}`, "barrier"),
    barrierFencing: (barrierId: string) => buildKey(basePrefix, `{${barrierId}}`, "barrier", "fencing"),
  };
}

export interface ResolvedCoordinationConfig {
  client: Redis;
  keyPrefix: string;
  defaultLeaseMs: number;
  defaultTimeoutMs: number;
  defaultRetryIntervalMs: number;
  logger: Logger | undefined;
  keyBuilder: ReturnType<typeof createCoordinationKeyBuilder>;
}

export function resolveCoordinationConfig(config: CoordinationClientConfig): ResolvedCoordinationConfig {
  if (!config.client) {
    throw new CoordinationConfigError("Redis client is required", "client");
  }
  
  if (config.defaultLeaseMs !== undefined) {
    if (!Number.isFinite(config.defaultLeaseMs) || config.defaultLeaseMs <= 0) {
      throw new CoordinationConfigError("defaultLeaseMs must be a positive finite number", "defaultLeaseMs");
    }
  }
  
  if (config.defaultTimeoutMs !== undefined) {
    if (!Number.isFinite(config.defaultTimeoutMs) || config.defaultTimeoutMs <= 0) {
      throw new CoordinationConfigError("defaultTimeoutMs must be a positive finite number", "defaultTimeoutMs");
    }
  }
  
  if (config.defaultRetryIntervalMs !== undefined) {
    if (!Number.isFinite(config.defaultRetryIntervalMs) || config.defaultRetryIntervalMs <= 0) {
      throw new CoordinationConfigError("defaultRetryIntervalMs must be a positive finite number", "defaultRetryIntervalMs");
    }
  }
  
  const keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX;
  
  return {
    client: config.client,
    keyPrefix,
    defaultLeaseMs: config.defaultLeaseMs ?? DEFAULT_LEASE_MS,
    defaultTimeoutMs: config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    defaultRetryIntervalMs: config.defaultRetryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS,
    logger: normalizeLogger(config.logger),
    keyBuilder: createCoordinationKeyBuilder(keyPrefix),
  };
}

export function generateOwnershipToken(): string {
  // Generate a cryptographically strong random token
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function generateOwnerId(prefix: string = "owner"): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}:${timestamp}:${random}`;
}

export function validateLeaseDuration(leaseMs: number, paramName: string = "leaseMs"): void {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new CoordinationConfigError(`${paramName} must be a positive finite number`, paramName);
  }
  if (leaseMs < 100) {
    throw new CoordinationConfigError(`${paramName} must be at least 100ms`, paramName);
  }
}

export function validateTimeout(timeoutMs: number | undefined, paramName: string = "timeoutMs"): void {
  if (timeoutMs !== undefined) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new CoordinationConfigError(`${paramName} must be a positive finite number`, paramName);
    }
  }
}

export function validateRetryInterval(retryIntervalMs: number | undefined, paramName: string = "retryIntervalMs"): void {
  if (retryIntervalMs !== undefined) {
    if (!Number.isFinite(retryIntervalMs) || retryIntervalMs <= 0) {
      throw new CoordinationConfigError(`${paramName} must be a positive finite number`, paramName);
    }
  }
}

export function validateResource(resource: string, paramName: string = "resource"): void {
  if (!resource || typeof resource !== "string" || resource.trim() === "") {
    throw new CoordinationConfigError(`${paramName} must be a non-empty string`, paramName);
  }
}

export function validatePermits(permits: number, paramName: string = "permits"): void {
  if (!Number.isFinite(permits) || permits < 1) {
    throw new CoordinationConfigError(`${paramName} must be a positive integer >= 1`, paramName);
  }
  if (!Number.isInteger(permits)) {
    throw new CoordinationConfigError(`${paramName} must be an integer`, paramName);
  }
}

export function validateRequiredCount(count: number, paramName: string = "requiredCount"): void {
  if (!Number.isFinite(count) || count < 1) {
    throw new CoordinationConfigError(`${paramName} must be a positive integer >= 1`, paramName);
  }
  if (!Number.isInteger(count)) {
    throw new CoordinationConfigError(`${paramName} must be an integer`, paramName);
  }
}

export function validateParticipantId(participantId: string, paramName: string = "participantId"): void {
  if (!participantId || typeof participantId !== "string" || participantId.trim() === "") {
    throw new CoordinationConfigError(`${paramName} must be a non-empty string`, paramName);
  }
}

export function validateGeneration(generation: number | undefined, paramName: string = "generation"): void {
  if (generation !== undefined) {
    if (!Number.isFinite(generation) || generation < 1) {
      throw new CoordinationConfigError(`${paramName} must be a positive integer >= 1`, paramName);
    }
    if (!Number.isInteger(generation)) {
      throw new CoordinationConfigError(`${paramName} must be an integer`, paramName);
    }
  }
}

export function validateToken(token: string, paramName: string = "token"): void {
  if (!token || typeof token !== "string" || token.trim() === "") {
    throw new CoordinationConfigError(`${paramName} must be a non-empty string`, paramName);
  }
}

export function validateOwnerId(ownerId: string | undefined, paramName: string = "ownerId"): void {
  if (ownerId !== undefined && (!ownerId || typeof ownerId !== "string" || ownerId.trim() === "")) {
    throw new CoordinationConfigError(`${paramName} must be a non-empty string`, paramName);
  }
}

export function calculateDeadline(timeoutMs: number): number {
  return Date.now() + timeoutMs;
}

export function isDeadlineExceeded(deadline: number): boolean {
  return Date.now() >= deadline;
}

export function getRemainingTime(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(resolve, ms);
    
    if (signal) {
      const abortHandler = () => {
        clearTimeout(timeoutId);
        reject(new DOMException("Operation cancelled", "AbortError"));
      };
      
      if (signal.aborted) {
        abortHandler();
        return;
      }
      
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
}

export class TimeoutError extends Error {
  constructor(message: string, public readonly operation: string) {
    super(message);
    this.name = "TimeoutError";
    Error.captureStackTrace(this, this.constructor);
  }
}

export function createTimeoutError(operation: string, timeoutMs: number): TimeoutError {
  return new TimeoutError(`${operation} timed out after ${timeoutMs}ms`, operation);
}

export function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === "AbortError";
}

export function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof TimeoutError;
}

export interface LuaScriptResult<T> {
  success: boolean;
  value?: T;
  error?: string;
}

export function parseLuaResult<T>(result: unknown): LuaScriptResult<T> {
  if (result === null || result === undefined) {
    return { success: false, error: "Lua script returned null/undefined" };
  }
  
  if (Array.isArray(result)) {
    // Redis Lua scripts typically return arrays
    const [success, ...rest] = result;
    if (success === 1 || success === true || success === "OK") {
      return { success: true, value: rest[0] as T };
    }
    return { success: false, error: String(rest[0] ?? "Lua script returned failure") };
  }
  
  if (result === 1 || result === true || result === "OK") {
    return { success: true, value: undefined as unknown as T };
  }
  
  if (result === 0 || result === false) {
    return { success: false, error: "Lua script returned false/0" };
  }
  
  return { success: false, error: `Unexpected Lua result: ${String(result)}` };
}

export function parseLuaArrayResult<T>(result: unknown): T[] {
  if (!Array.isArray(result)) {
    return [];
  }
  return result as T[];
}

export function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (typeof value === "bigint") return Number(value);
  return 0;
}

export function toString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

export function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value === "1" || value.toLowerCase() === "true";
  return false;
}