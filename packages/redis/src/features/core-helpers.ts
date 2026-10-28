import { Redis, Cluster } from "ioredis";

export interface KeyBuilderOptions {
  separator?: string;
  allowEmpty?: boolean;
}

export function buildKey(
  ...parts: Array<string | number | null | undefined>
): string {
  const separator = ":";
  const built: string[] = [];

  for (const part of parts) {
    if (part === null || part === undefined) {
      throw new Error("Key segments must not be null or undefined");
    }

    const value = String(part).trim();
    if (value === "" && !false) {
      throw new Error("Key segments must not be empty");
    }

    built.push(value);
  }

  if (built.length === 0) {
    throw new Error("At least one key segment is required");
  }

  return built.join(separator);
}

export function serialize<T>(value: T): string {
  return JSON.stringify(value);
}

export function deserialize<T>(
  raw: string | null | undefined,
): T | null {
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function jitterTtl(baseSeconds: number, jitter = 0.1): number {
  if (!Number.isFinite(baseSeconds) || baseSeconds <= 0) {
    throw new Error("baseSeconds must be a positive finite number");
  }

  if (!Number.isFinite(jitter) || jitter < 0 || jitter >= 1) {
    throw new Error("jitter must be between 0 and 1");
  }

  const factor = 1 - jitter + Math.random() * jitter * 2;
  return Math.max(1, Math.round(baseSeconds * factor));
}

export async function setIfAbsent(
  client: Redis,
  key: string,
  value: string,
  options: { ttlSeconds?: number } = {},
): Promise<boolean> {
  if (options.ttlSeconds !== undefined) {
    if (!Number.isFinite(options.ttlSeconds) || options.ttlSeconds <= 0) {
      throw new Error("ttlSeconds must be a positive finite number");
    }

    const result = await (client as unknown as { set(...args: unknown[]): Promise<unknown> }).set(key, value, "NX", "EX", options.ttlSeconds);
    return result === "OK";
  }

  const result = await (client as unknown as { set(...args: unknown[]): Promise<unknown> }).set(key, value, "NX");
  return result === "OK";
}

export async function compareAndSwap(
  client: Redis,
  key: string,
  expected: string | null,
  next: string,
  options: { ttlSeconds?: number; maxRetries?: number } = {},
): Promise<boolean> {
  if (options.ttlSeconds !== undefined) {
    if (!Number.isFinite(options.ttlSeconds) || options.ttlSeconds <= 0) {
      throw new Error("ttlSeconds must be a positive finite number");
    }
  }

  const retries = options.maxRetries ?? 5;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await client.watch(key);
    const current = await client.get(key);
    if (current !== expected) {
      await client.unwatch();
      return false;
    }

    const multi = client.multi();
    multi.set(key, next);
    if (options.ttlSeconds !== undefined) {
      multi.expire(key, options.ttlSeconds);
    }

    const result = await multi.exec();
    if (result) {
      return true;
    }
  }

  return false;
}

export interface RedisCapabilities {
  version: string | null;
  isCluster: boolean;
  hasStreams: boolean;
  hasAcl: boolean;
  modules: string[];
}

export async function detectCapabilities(
  client: Redis,
): Promise<RedisCapabilities> {
  let serverInfo: string;
  try {
    serverInfo = await client.info("server");
  } catch {
    return {
      version: null,
      isCluster: false,
      hasStreams: true,
      hasAcl: false,
      modules: [],
    };
  }

  const versionMatch = serverInfo.match(/^redis_version:(.+)$/m);
  const version = versionMatch ? versionMatch[1].trim() : null;

  let cluster = "0";
  try {
    const clusterInfo = await client.info("cluster");
    const clusterMatch = clusterInfo.match(/^cluster_enabled:(\d+)$/m);
    cluster = clusterMatch ? clusterMatch[1] : "0";
  } catch {
    cluster = "0";
  }

  const modules = Array.from(
    serverInfo.matchAll(/^module\{(.*?)\}: (.+)$/gm),
    (match) => `${match[1]}:${match[2]}`,
  );

  return {
    version,
    isCluster: cluster === "1",
    hasStreams: true,
    hasAcl: version !== null && majorVersion(version) >= 6,
    modules,
  };
}

function majorVersion(version: string): number {
  const match = version.match(/^(\d+)/);
  return match ? Number(match[1]) : 0;
}

export function createClusterClient(
  nodes: string[] | { host: string; port: number }[],
  options?: Record<string, unknown>,
): Cluster {
  // Runtime forwards options verbatim to ioredis Cluster.
  const normalized = nodes.map((node) => {
    if (typeof node !== "string") {
      return node;
    }
    try {
      if (node.includes("://")) {
        const url = new URL(node);
        return {
          host: url.hostname,
          port: url.port ? Number(url.port) : 6379,
        };
      }
    } catch {
      // Fall through to the simpler host:port parser.
    }
    const [host, port] = node.split(":");
    return {
      host,
      port: port ? Number(port) : 6379,
    };
  });

  const cluster = new Cluster(normalized, (options ?? {}) as unknown as ConstructorParameters<typeof Cluster>[1]);
  return cluster;
}

export { Cluster } from "ioredis";
