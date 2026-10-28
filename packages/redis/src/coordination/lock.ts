/* eslint-disable */
import { createLeaseManager } from "./lease.js";
import type { CreateLeaseManagerOptions } from "./lease.js";
import { generateOwnerId, sleep } from "./utils.js";
import { resolveCoordinationConfig } from "./utils.js";
import { LockLeaseLostError } from "./errors.js";
import type {
  LockAcquireOptions,
  LockTryOptions,
  LockRenewOptions,
  LockReleaseOptions,
  WithLockResult,
} from "./types.js";

function createLockManagerImpl(opts: CreateLeaseManagerOptions) {
  const lease = createLeaseManager(opts);
  const logger = opts.logger;

  async function withLock<T>(
    resourceOrOptions: string | LockAcquireOptions,
    leaseMsOrCallback: number | ((handle: any) => T | Promise<T>),
    callbackOrOptions?: ((handle: any) => T | Promise<T>) | Record<string, unknown>,
    optionsArg?: Record<string, unknown>,
  ): Promise<WithLockResult<T>> {
    // Resolve overloads
    let resource: string;
    let leaseMs: number;
    let callback: (handle: any) => T | Promise<T>;
    let options: Record<string, unknown> = {};
    if (typeof resourceOrOptions === "string") {
      resource = resourceOrOptions;
      leaseMs = leaseMsOrCallback as number;
      callback = callbackOrOptions as any;
      options = (optionsArg ?? {}) as any;
    } else {
      const o = resourceOrOptions as LockAcquireOptions;
      resource = o.resource;
      leaseMs = o.leaseMs;
      callback = leaseMsOrCallback as any;
      options = (callbackOrOptions ?? {}) as any;
    }

    const timeoutMs = (options.timeoutMs ?? opts.defaultTimeoutMs) as number;
    const retryIntervalMs = (options.retryIntervalMs ?? opts.defaultRetryIntervalMs) as number;
    const signal = options.signal as AbortSignal | undefined;
    const renewIntervalMs = (options.renewIntervalMs ?? Math.max(100, Math.floor(leaseMs / 3))) as number;
    const autoRenew = Boolean(options.autoRenew ?? true);

    const acquired = await lease.acquire({
      resource,
      leaseMs,
      timeoutMs,
      retryIntervalMs,
      signal,
      ownerId: options.ownerId as string | undefined,
    });
    if (!acquired.acquired || !acquired.token) {
      throw new Error(acquired.error ?? "Failed to acquire lock");
    }

    const token = acquired.token;
    const fencingToken = acquired.fencingToken ?? 0;

    const abortController = new AbortController();
    const handle: any = {
      token,
      fencingToken,
      resource,
      leaseLost: () => abortController.signal.aborted,
      signal: abortController.signal,
    };

    let leaseHeld = true;
    let renewalTimer: NodeJS.Timeout | null = null;
    let renewalFailError: Error | null = null;

    const renew = async () => {
      const r = await lease.renew({ resource, token, leaseMs }).catch((e) => ({ renewed: false, error: String(e) }));
      if (!r.renewed) {
        leaseHeld = false;
        renewalFailError = new LockLeaseLostError("Lock lease lost during execution", resource, fencingToken);
        abortController.abort();
        if (logger) logger.warn?.("lock lease lost", { resource });
      }
    };

    if (autoRenew) {
      renewalTimer = setInterval(() => {
        void renew();
      }, renewIntervalMs);
       
      (renewalTimer as any).unref?.();
    }

    let callbackError: unknown;
    let callbackResult: any;
    let releaseError: unknown;

    try {
      callbackResult = await callback(handle);
    } catch (e) {
      callbackError = e;
    } finally {
      if (renewalTimer) {
        clearInterval(renewalTimer);
        renewalTimer = null;
      }
      try {
        await lease.release({ resource, token });
      } catch (e) {
        releaseError = e;
      }
    }

    if (callbackError) {
      if (releaseError && logger) logger.error?.("release failed after callback error", { resource });
      throw callbackError;
    }
    if (releaseError) throw releaseError;

    return {
      value: callbackResult,
      lockHeld: leaseHeld,
      fencingToken,
    };
  }

  const manager: any = {
    acquireLock: (o: LockAcquireOptions) => lease.acquire(o),
    tryLock: (o: LockTryOptions) => lease.tryAcquire(o),
    renewLock: (o: LockRenewOptions) => lease.renew(o),
    releaseLock: (o: LockReleaseOptions) => lease.release(o),
    getLockStatus: (resource: string) => lease.getStatus(resource),
    withLock,
    // passthrough names
    acquire: lease.acquire.bind(lease),
    tryAcquire: lease.tryAcquire.bind(lease),
    renew: lease.renew.bind(lease),
    release: lease.release.bind(lease),
    getStatus: lease.getStatus.bind(lease),
  };

  return manager;
}


function __toConfig(input: any, options?: any) { return (input && typeof input.eval === "function") ? { client: input, ...(options || {}) } : (options ? { ...input, ...options } : input); }
export function createLockManager(input: any, options?: any) {
  const resolved = resolveCoordinationConfig(__toConfig(input, options));
  return createLockManagerImpl({
    client: resolved.client,
    keyBuilder: resolved.keyBuilder,
    defaultLeaseMs: resolved.defaultLeaseMs,
    defaultTimeoutMs: resolved.defaultTimeoutMs,
    defaultRetryIntervalMs: resolved.defaultRetryIntervalMs,
    logger: resolved.logger,
  });
}
