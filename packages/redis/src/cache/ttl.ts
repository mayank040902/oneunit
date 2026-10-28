import { jitterTtl } from "../features/core-helpers.js";
import type { CacheSetOptions } from "./types.js";

export function expiresInSeconds(options?: CacheSetOptions, defaultTtlSeconds?: number): number | undefined {
  if (options?.ttlSeconds !== undefined) {
    return options.ttlSeconds;
  }
  return defaultTtlSeconds;
}

export function effectiveTtl(
  options: CacheSetOptions | undefined,
  optionsRef: { defaultTtlSeconds?: number; jitter?: number },
): number | undefined {
  let ttl = expiresInSeconds(options, optionsRef.defaultTtlSeconds);
  if (ttl !== undefined && ttl > 0 && optionsRef.jitter) {
    ttl = jitterTtl(ttl, optionsRef.jitter);
  }
  return ttl;
}
