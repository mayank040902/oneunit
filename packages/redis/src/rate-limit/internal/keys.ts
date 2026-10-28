 
import { buildKey } from "../../features/core-helpers.js";

export function rateLimitKey(prefix: string, resource: string, suffix?: string): string {
  const parts = [prefix, "rl", resource];
  if (suffix) parts.push(suffix);
  return buildKey(...parts);
}
