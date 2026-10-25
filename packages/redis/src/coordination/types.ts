/* eslint-disable */
import { Redis } from "ioredis";
import { normalizeLogger, type Logger } from "../logger.js";

export interface CoordinationOptions {
  /** Redis client instance */
  client: Redis;
  /** Optional key prefix for all coordination keys */
  keyPrefix?: string;
  /** Optional logger */
  logger?: Logger;
}

/** Result of a lock acquisition attempt */
export interface LockAcquireResult {
  /** Whether the lock was acquired */
  acquired: boolean;
  /** Unique ownership token if acquired */
  token?: string;
  /** Fencing token (monotonically increasing) if acquired */
  fencingToken?: number;
  /** Remaining TTL in milliseconds if acquired */
  ttlMs?: number;
  /** Error message if not acquired */
  error?: string;
}

/** Result of a lock release attempt */
export interface LockReleaseResult {
  /** Whether the lock was released */
  released: boolean;
  /** Error message if not released */
  error?: string;
}

/** Result of a lock renewal attempt */
export interface LockRenewResult {
  /** Whether the lock was renewed */
  renewed: boolean;
  /** New TTL in milliseconds if renewed */
  ttlMs?: number;
  /** Error message if not renewed */
  error?: string;
}

/** Lock status information */
export interface LockStatus {
  /** Whether the lock exists */
  exists: boolean;
  /** Current owner token if exists */
  owner?: string;
  /** Remaining TTL in milliseconds */
  ttlMs?: number;
  /** Current fencing token */
  fencingToken?: number;
}

/** Options for acquiring a lock */
export interface LockAcquireOptions {
  /** Lock resource name */
  resource: string;
  /** Lease duration in milliseconds */
  leaseMs: number;
  /** Maximum time to wait for acquisition in milliseconds */
  timeoutMs?: number;
  /** Retry interval in milliseconds */
  retryIntervalMs?: number;
  /** Optional signal for cancellation */
  signal?: AbortSignal;
  /** Unique owner identifier (generated if not provided) */
  ownerId?: string;
}

/** Options for trying to acquire a lock without waiting */
export interface LockTryOptions {
  /** Lock resource name */
  resource: string;
  /** Lease duration in milliseconds */
  leaseMs: number;
  /** Unique owner identifier (generated if not provided) */
  ownerId?: string;
}

/** Options for renewing a lock */
export interface LockRenewOptions {
  /** Lock resource name */
  resource: string;
  /** Current ownership token */
  token: string;
  /** Additional lease time in milliseconds */
  leaseMs: number;
}

/** Options for releasing a lock */
export interface LockReleaseOptions {
  /** Lock resource name */
  resource: string;
  /** Current ownership token */
  token: string;
}

/** Result of a callback execution with lock */
export interface WithLockResult<T> {
  /** Result of the callback */
  value: T;
  /** Whether the lock was held for the entire execution */
  lockHeld: boolean;
  /** Fencing token used */
  fencingToken: number;
}

/** Semaphore acquire result */
export interface SemaphoreAcquireResult {
  /** Whether a permit was acquired */
  acquired: boolean;
  /** Unique permit token if acquired */
  token?: string;
  /** Fencing token if acquired */
  fencingToken?: number;
  /** Remaining TTL in milliseconds if acquired */
  ttlMs?: number;
  /** Current available permits */
  availablePermits?: number;
  /** Error message if not acquired */
  error?: string;
}

/** Semaphore release result */
export interface SemaphoreReleaseResult {
  /** Whether the permit was released */
  released: boolean;
  /** Current available permits */
  availablePermits?: number;
  /** Error message if not released */
  error?: string;
}

/** Semaphore status */
export interface SemaphoreStatus {
  /** Total permits configured */
  totalPermits: number;
  /** Currently available permits */
  availablePermits: number;
  /** Active permit holders */
  holders: Array<{ token: string; expiresAt: number }>;
}

/** Options for acquiring a semaphore permit */
export interface SemaphoreAcquireOptions {
  /** Semaphore resource name */
  resource: string;
  /** Maximum concurrent permits */
  permits: number;
  /** Lease duration in milliseconds */
  leaseMs: number;
  /** Maximum time to wait for acquisition in milliseconds */
  timeoutMs?: number;
  /** Retry interval in milliseconds */
  retryIntervalMs?: number;
  /** Optional signal for cancellation */
  signal?: AbortSignal;
  /** Unique owner identifier (generated if not provided) */
  ownerId?: string;
}

/** Options for trying to acquire a semaphore permit */
export interface SemaphoreTryOptions {
  /** Semaphore resource name */
  resource: string;
  /** Maximum concurrent permits */
  permits: number;
  /** Lease duration in milliseconds */
  leaseMs: number;
  /** Unique owner identifier (generated if not provided) */
  ownerId?: string;
}

/** Options for renewing a semaphore permit */
export interface SemaphoreRenewOptions {
  /** Semaphore resource name */
  resource: string;
  /** Current permit token */
  token: string;
  /** Additional lease time in milliseconds */
  leaseMs: number;
}

/** Options for releasing a semaphore permit */
export interface SemaphoreReleaseOptions {
  /** Semaphore resource name */
  resource: string;
  /** Current permit token */
  token: string;
}

/** Single-flight execution result */
export interface SingleFlightResult<T> {
  /** The result value */
  value: T;
  /** Whether this caller was the owner (executed the work) */
  isOwner: boolean;
  /** Fencing token */
  fencingToken: number;
}

/** Options for single-flight execution */
export interface SingleFlightOptions<T> {
  /** Unique key for the single-flight operation */
  key: string;
  /** Function to execute (only by owner) */
  execute: () => Promise<T>;
  /** Lease duration in milliseconds */
  leaseMs: number;
  /** Maximum time to wait for result in milliseconds */
  timeoutMs?: number;
  /** Optional signal for cancellation */
  signal?: AbortSignal;
  /** Retry interval in milliseconds */
  retryIntervalMs?: number;
  /** Result TTL in milliseconds (for sharing result with followers) */
  resultTtlMs?: number;
  /** Unique owner identifier (generated if not provided) */
  ownerId?: string;
}

/** Leader election status */
export interface LeaderElectionStatus {
  /** Whether this instance is the leader */
  isLeader: boolean;
  /** Current leader identity if known */
  leaderId?: string;
  /** Lease expiration timestamp */
  leaseExpiresAt?: number;
  /** Current term/fencing token */
  term?: number;
}

/** Leader election event types */
export type LeaderElectionEventType = "leader-acquired" | "leader-lost" | "leader-error";

/** Leader election event */
export interface LeaderElectionEvent {
  type: LeaderElectionEventType;
  timestamp: number;
  leaderId?: string;
  term?: number;
  error?: Error;
}

/** Options for leader election */
export interface LeaderElectionOptions {
  /** Election resource name */
  resource: string;
  /** Lease duration in milliseconds */
  leaseMs: number;
  /** Renewal interval in milliseconds (default: leaseMs / 3) */
  renewalIntervalMs?: number;
  /** Unique candidate identity */
  candidateId: string;
  /** Optional signal for cancellation */
  signal?: AbortSignal;
  /** Event handler */
  onEvent?: (event: LeaderElectionEvent) => void;
}

/** Job claim result */
export interface JobClaimResult {
  /** Whether the job was claimed */
  claimed: boolean;
  /** Unique claim token if claimed */
  token?: string;
  /** Fencing token if claimed */
  fencingToken?: number;
  /** Remaining TTL in milliseconds if claimed */
  ttlMs?: number;
  /** Current job status if not claimed */
  status?: "claimed" | "completed" | "expired" | "failed";
  /** Error message if not claimed */
  error?: string;
}

/** Job claim status */
export interface JobClaimStatus {
  /** Job identifier */
  jobId: string;
  /** Current claim status */
  status: "unclaimed" | "claimed" | "completed" | "expired" | "failed";
  /** Current claimant token if claimed */
  claimant?: string;
  /** Claim expiration timestamp if claimed */
  expiresAt?: number;
  /** Fencing token */
  fencingToken?: number;
  /** Completion result if completed */
  result?: unknown;
  /** Error if failed */
  error?: string;
}

/** Options for claiming a job */
export interface JobClaimOptions {
  /** Job identifier */
  jobId: string;
  /** Lease duration in milliseconds */
  leaseMs: number;
  /** Maximum time to wait for claim in milliseconds */
  timeoutMs?: number;
  /** Retry interval in milliseconds */
  retryIntervalMs?: number;
  /** Optional signal for cancellation */
  signal?: AbortSignal;
  /** Unique claimant identifier (generated if not provided) */
  claimantId?: string;
}

/** Options for completing a job claim */
export interface JobCompleteOptions {
  /** Job identifier */
  jobId: string;
  /** Current claim token */
  token: string;
  /** Completion result */
  result?: unknown;
  /** Fencing token for downstream validation */
  fencingToken?: number;
}

/** Options for releasing a job claim */
export interface JobReleaseOptions {
  /** Job identifier */
  jobId: string;
  /** Current claim token */
  token: string;
}

/** Resource lease result */
export interface LeaseResult {
  /** Whether the lease was acquired */
  acquired: boolean;
  /** Unique lease token if acquired */
  token?: string;
  /** Fencing token if acquired */
  fencingToken?: number;
  /** Lease expiration timestamp if acquired */
  expiresAt?: number;
  /** Error message if not acquired */
  error?: string;
}

/** Resource lease status */
export interface LeaseStatus {
  /** Resource identifier */
  resource: string;
  /** Whether the lease exists */
  exists: boolean;
  /** Current lease holder token if exists */
  holder?: string;
  /** Lease expiration timestamp if exists */
  expiresAt?: number;
  /** Current fencing token */
  fencingToken?: number;
}

/** Options for acquiring a resource lease */
export interface LeaseAcquireOptions {
  /** Resource identifier */
  resource: string;
  /** Lease duration in milliseconds */
  leaseMs: number;
  /** Maximum time to wait for acquisition in milliseconds */
  timeoutMs?: number;
  /** Retry interval in milliseconds */
  retryIntervalMs?: number;
  /** Optional signal for cancellation */
  signal?: AbortSignal;
  /** Unique holder identifier (generated if not provided) */
  holderId?: string;
}

/** Options for renewing a resource lease */
export interface LeaseRenewOptions {
  /** Resource identifier */
  resource: string;
  /** Current lease token */
  token: string;
  /** Additional lease time in milliseconds */
  leaseMs: number;
}

/** Options for releasing a resource lease */
export interface LeaseReleaseOptions {
  /** Resource identifier */
  resource: string;
  /** Current lease token */
  token: string;
}

/** Barrier arrival result */
export interface BarrierArrivalResult {
  /** Whether the barrier was released (all participants arrived) */
  released: boolean;
  /** Current participant count */
  participantCount: number;
  /** Required participant count */
  requiredCount: number;
  /** Generation/round number */
  generation: number;
  /** Fencing token */
  fencingToken: number;
  /** Error message if failed */
  error?: string;
}

/** Barrier status */
export interface BarrierStatus {
  /** Barrier identifier */
  barrierId: string;
  /** Current generation/round */
  generation: number;
  /** Required participant count */
  requiredCount: number;
  /** Current participant count */
  participantCount: number;
  /** Whether the barrier is released */
  released: boolean;
  /** Participant tokens */
  participants: string[];
}

/** Options for barrier arrival */
export interface BarrierArrivalOptions {
  /** Barrier identifier */
  barrierId: string;
  /** Required number of participants */
  requiredCount: number;
  /** Unique participant identifier */
  participantId: string;
  /** Maximum time to wait in milliseconds */
  timeoutMs?: number;
  /** Optional signal for cancellation */
  signal?: AbortSignal;
  /** Generation/round number (auto-incremented if not provided) */
  generation?: number;
}

/** Configuration for a coordination client */
export interface CoordinationClientConfig {
  /** Redis client instance */
  client: Redis;
  /** Key prefix for all coordination keys */
  keyPrefix?: string;
  /** Default lease duration in milliseconds */
  defaultLeaseMs?: number;
  /** Default acquisition timeout in milliseconds */
  defaultTimeoutMs?: number;
  /** Default retry interval in milliseconds */
  defaultRetryIntervalMs?: number;
  /** Logger instance */
  logger?: Logger;
}

/** Internal lock state for Lua scripts */
export interface LockState {
  token: string;
  fencingToken: number;
  expiresAt: number;
}

/** Internal semaphore state for Lua scripts */
export interface SemaphoreState {
  permits: number;
  holders: Array<{ token: string; expiresAt: number }>;
  fencingToken: number;
}

/** Internal single-flight state for Lua scripts */
export interface SingleFlightState {
  owner: string;
  token: string;
  fencingToken: number;
  expiresAt: number;
  result?: string;
  resultExpiresAt?: number;
  status: "pending" | "completed" | "failed";
  error?: string;
}

/** Internal leader election state for Lua scripts */
export interface LeaderElectionState {
  leaderId: string;
  term: number;
  expiresAt: number;
}

/** Internal job claim state for Lua scripts */
export interface JobClaimState {
  jobId: string;
  claimant: string;
  token: string;
  fencingToken: number;
  expiresAt: number;
  status: "claimed" | "completed" | "expired" | "failed";
  result?: string;
  error?: string;
}

/** Internal resource lease state for Lua scripts */
export interface LeaseState {
  holder: string;
  token: string;
  fencingToken: number;
  expiresAt: number;
}

/** Internal barrier state for Lua scripts */
export interface BarrierState {
  generation: number;
  requiredCount: number;
  participants: string[];
  released: boolean;
  fencingToken: number;
}