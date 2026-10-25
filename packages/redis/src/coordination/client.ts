/* eslint-disable */
import { Redis } from "ioredis";
import { resolveCoordinationConfig } from "./utils.js";
import { createCoordinationKeyBuilder } from "./utils.js";
import type { CoordinationClientConfig } from "./types.js";
import type { Logger } from "../logger.js";
import { createLockManager } from "./lock.js";
import { createSemaphoreManager } from "./semaphore.js";
import { createSingleFlightManager } from "./single-flight.js";
import { LeaderElectionCoordinator } from "./leader-election.js";
import { createJobClaimManager } from "./job-claim.js";
import { createResourceLeaseManager } from "./resource-lease.js";
import { createBarrierCoordinator } from "./barrier.js";

export interface CoordinationClient {
  readonly client: Redis;
  readonly keyBuilder: ReturnType<typeof createCoordinationKeyBuilder>;
  readonly config: ReturnType<typeof resolveCoordinationConfig>;

  // Locks
  acquireLock: (opts: any) => Promise<any>;
  tryLock: (opts: any) => Promise<any>;
  renewLock: (opts: any) => Promise<any>;
  releaseLock: (opts: any) => Promise<any>;
  withLock: (...args: any[]) => Promise<any>;
  getLockStatus: (resource: string) => Promise<any>;

  // Semaphore
  acquireSemaphore: (opts: any) => Promise<any>;
  tryAcquireSemaphore: (opts: any) => Promise<any>;
  renewSemaphore: (opts: any) => Promise<any>;
  releaseSemaphore: (opts: any) => Promise<any>;
  getSemaphoreStatus: (resource: string, permits: number) => Promise<any>;

  // Single flight
  singleFlight: <T>(opts: any) => Promise<any>;

  // Leader election
  createLeaderElection: (opts: any) => LeaderElectionCoordinator;

  // Job claims
  claimJob: (opts: any) => Promise<any>;
  renewJobClaim: (opts: any) => Promise<any>;
  releaseJobClaim: (opts: any) => Promise<any>;
  completeJobClaim: (opts: any) => Promise<any>;
  failJobClaim: (opts: any) => Promise<any>;
  getJobClaimStatus: (jobId: string) => Promise<any>;

  // Resource leases
  acquireLease: (opts: any) => Promise<any>;
  renewLease: (opts: any) => Promise<any>;
  releaseLease: (opts: any) => Promise<any>;
  getLeaseStatus: (resource: string) => Promise<any>;

  // Barriers
  arriveBarrier: (opts: any) => Promise<any>;
  getBarrierStatus: (barrierId: string, generation: number) => Promise<any>;
}

export function createCoordinationClient(config: CoordinationClientConfig): CoordinationClient {
  const resolved = resolveCoordinationConfig(config);
  const client = resolved.client;
  const keyBuilder = resolved.keyBuilder;

  const lockManager = createLockManager({
    client,
    keyBuilder,
    defaultLeaseMs: resolved.defaultLeaseMs,
    defaultTimeoutMs: resolved.defaultTimeoutMs,
    defaultRetryIntervalMs: resolved.defaultRetryIntervalMs,
    logger: resolved.logger,
  });

  const semaphoreManager = createSemaphoreManager({
    client,
    keyBuilder,
    defaultTimeoutMs: resolved.defaultTimeoutMs,
    defaultRetryIntervalMs: resolved.defaultRetryIntervalMs,
    logger: resolved.logger,
  });

  const singleFlightManager = createSingleFlightManager({
    client,
    keyBuilder,
    defaultTimeoutMs: resolved.defaultTimeoutMs,
    defaultRetryIntervalMs: resolved.defaultRetryIntervalMs,
    logger: resolved.logger,
  });

  const jobClaimManager = createJobClaimManager({
    client,
    keyBuilder,
    defaultTimeoutMs: resolved.defaultTimeoutMs,
    defaultRetryIntervalMs: resolved.defaultRetryIntervalMs,
    logger: resolved.logger,
  });

  const leaseManager = createResourceLeaseManager({
    client,
    keyBuilder,
    defaultLeaseMs: resolved.defaultLeaseMs,
    defaultTimeoutMs: resolved.defaultTimeoutMs,
    defaultRetryIntervalMs: resolved.defaultRetryIntervalMs,
    logger: resolved.logger,
  });

  const barrierCoordinator = createBarrierCoordinator({
    client,
    keyBuilder,
    logger: resolved.logger,
  });

  return {
    client,
    keyBuilder,
    config: resolved,
    acquireLock: (opts: any) => lockManager.acquireLock(opts),
    tryLock: (opts: any) => lockManager.tryLock(opts),
    renewLock: (opts: any) => lockManager.renewLock(opts),
    releaseLock: (opts: any) => lockManager.releaseLock(opts),
    withLock: (...args: any[]) => lockManager.withLock(...args),
    getLockStatus: (resource: string) => lockManager.getLockStatus(resource),
    acquireSemaphore: (opts: any) => semaphoreManager.acquire(opts),
    tryAcquireSemaphore: (opts: any) => semaphoreManager.tryAcquire(opts),
    renewSemaphore: (opts: any) => semaphoreManager.renew(opts),
    releaseSemaphore: (opts: any) => semaphoreManager.release(opts),
    getSemaphoreStatus: (resource: string, permits: number) => semaphoreManager.getStatus(resource, permits),
    singleFlight: (opts: any) => singleFlightManager.execute(opts),
    createLeaderElection: (opts: any) =>
      new LeaderElectionCoordinator(client, keyBuilder, opts, resolved.logger),
    claimJob: (opts: any) => jobClaimManager.claim(opts),
    renewJobClaim: (opts: any) => jobClaimManager.renew(opts),
    releaseJobClaim: (opts: any) => jobClaimManager.release(opts),
    completeJobClaim: (opts: any) => jobClaimManager.complete(opts),
    failJobClaim: (opts: any) => jobClaimManager.fail(opts),
    getJobClaimStatus: (jobId: string) => jobClaimManager.getStatus(jobId),
    acquireLease: (opts: any) => leaseManager.acquire(opts),
    renewLease: (opts: any) => leaseManager.renew(opts),
    releaseLease: (opts: any) => leaseManager.release(opts),
    getLeaseStatus: (resource: string) => leaseManager.getStatus(resource),
    arriveBarrier: (opts: any) => barrierCoordinator.arrive(opts),
    getBarrierStatus: (barrierId: string, generation: number) => barrierCoordinator.getStatus(barrierId, generation),
  };
}
