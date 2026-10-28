export function cacheKey(prefix: string, key: string): string {
  return `${prefix}${key}`;
}

export function tagKey(prefix: string, tag: string): string {
  return `${prefix}tag:${tag}`;
}
