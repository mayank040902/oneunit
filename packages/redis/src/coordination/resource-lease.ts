import { resolveCoordinationConfig } from "./utils.js";
/* eslint-disable */
import { createLeaseManager } from "./lease.js";
import type { CreateLeaseManagerOptions } from "./lease.js";
import type {
  LeaseResult,
  LeaseAcquireOptions,
  LeaseRenewOptions,
  LeaseReleaseOptions,
  LeaseStatus,
} from "./types.js";

export interface ResourceLeaseManager {
  acquire(opts: LeaseAcquireOptions): Promise<LeaseResult>;
  renew(opts: LeaseRenewOptions): Promise<{ renewed: boolean; error?: string; ttlMs?: number }>;
  release(opts: LeaseReleaseOptions): Promise<{ released: boolean; error?: string }>;
  getStatus(resource: string): Promise<LeaseStatus>;
}

export interface CreateResourceLeaseManagerOptions extends CreateLeaseManagerOptions {}

function createResourceLeaseManagerImpl(opts: CreateResourceLeaseManagerOptions): ResourceLeaseManager {
  const base = createLeaseManager({
    ...opts,
    keyFn: (resource) => opts.keyBuilder.lease(resource),
  });
  return {
    async acquire(o: LeaseAcquireOptions): Promise<LeaseResult> {
      const r: any = await base.acquire({
        resource: o.resource,
        leaseMs: o.leaseMs,
        timeoutMs: o.timeoutMs,
        retryIntervalMs: o.retryIntervalMs,
        signal: o.signal,
        ownerId: o.holderId,
      } as any);
      if (!r.acquired) {
        return { acquired: false, error: r.error ?? "not acquired" };
      }
      const now = Date.now();
      return {
        acquired: true,
        token: r.token,
        fencingToken: r.fencingToken,
        expiresAt: r.ttlMs ? now + r.ttlMs : undefined,
      };
    },
    async renew(o: LeaseRenewOptions) {
      const r: any = await base.renew({ resource: o.resource, token: o.token, leaseMs: o.leaseMs } as any);
      return { renewed: r.renewed, error: r.error, ttlMs: r.ttlMs };
    },
    async release(o: LeaseReleaseOptions) {
      const r: any = await base.release({ resource: o.resource, token: o.token } as any);
      return { released: r.released, error: r.error };
    },
    async getStatus(resource: string): Promise<LeaseStatus> {
      const st: any = await base.getStatus(resource);
      const now = Date.now();
      return {
        resource,
        exists: st.exists,
        holder: st.owner,
        expiresAt: st.ttlMs !== undefined ? now + st.ttlMs : undefined,
        fencingToken: st.fencingToken,
      };
    },
  };
}


function __toConfig(input: any, options?: any) { return (input && typeof input.eval === "function") ? { client: input, ...(options || {}) } : (options ? { ...input, ...options } : input); }
export function createResourceLeaseManager(input: any, options?: any) {
  const resolved = resolveCoordinationConfig(__toConfig(input, options));
  return createResourceLeaseManagerImpl({
    client: resolved.client,
    keyBuilder: resolved.keyBuilder,
    defaultLeaseMs: resolved.defaultLeaseMs,
    defaultTimeoutMs: resolved.defaultTimeoutMs,
    defaultRetryIntervalMs: resolved.defaultRetryIntervalMs,
    logger: resolved.logger,
  });
}
