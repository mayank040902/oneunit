import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MicroserviceConfigSchema, MicroserviceConfig, DeepPartial } from './schema.js';

// Objects under these keys hold security-sensitive credential
// material; overrides replace them wholesale instead of merging,
// so an override cannot produce a hybrid credential block.
const REPLACE_ONLY_KEYS = new Set(['credentials']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, overrides: unknown, key?: string): unknown {
  if (Array.isArray(overrides) || !isPlainObject(overrides)) {
    return overrides;
  }
  if (!isPlainObject(base) || (key !== undefined && REPLACE_ONLY_KEYS.has(key))) {
    return overrides;
  }
  const merged: Record<string, unknown> = { ...base };
  for (const [field, value] of Object.entries(overrides)) {
    merged[field] = deepMerge(base[field], value, field);
  }
  return merged;
}

function deepFreeze(value: unknown): void {
  if (Array.isArray(value) || isPlainObject(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
}

// Deterministic precedence: schema defaults < environment <
// config file < programmatic overrides. Plain objects deep-merge
// field by field; arrays, scalars, and security-sensitive objects
// (credentials) are replaced. The merged result is validated once
// more with the full schema and returned frozen.
export function mergeConfig(
  base: MicroserviceConfig,
  overrides: DeepPartial<MicroserviceConfig> = {},
): MicroserviceConfig {
  const merged = deepMerge(base, overrides) as MicroserviceConfig;
  const result = MicroserviceConfigSchema.safeParse(merged);

  if (!result.success) {
    const errors = result.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Invalid configuration after merge:\n${errors}`);
  }

  deepFreeze(result.data);
  return result.data;
}

export function loadConfig(configPath?: string): MicroserviceConfig {
  const path = configPath || process.env['CONFIG_PATH'] || resolve(process.cwd(), 'config.json');
  
  let config: unknown;
  
  try {
    const fileContent = readFileSync(path, 'utf-8');
    config = JSON.parse(fileContent);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      config = buildConfigFromEnv();
    } else {
      throw new Error(`Failed to load config from ${path}: ${err}`);
    }
  }
  
  const result = MicroserviceConfigSchema.safeParse(config);
  
  if (!result.success) {
    const errors = result.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${errors}`);
  }
  
  return result.data;
}

function parseEnvJson(value: string, variable: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid JSON in environment variable ${variable}: value could not be parsed`);
  }
}

function parseBooleanEnv(value: string | undefined, defaultValue: boolean = false): boolean {
  if (value === undefined || value === '') return defaultValue;
  return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
}

export function buildConfigFromEnv(): Record<string, unknown> {
  const env = process.env;
  return {
    service: {
      id: env['SERVICE_ID'] || crypto.randomUUID(),
      name: env['SERVICE_NAME'] || 'microservice-server',
      instanceId: env['SERVICE_INSTANCE_ID'] || crypto.randomUUID(),
      credentials: env['SERVICE_CREDENTIALS'] ? parseEnvJson(env['SERVICE_CREDENTIALS'], 'SERVICE_CREDENTIALS') : undefined,
      endpoints: env['SERVICE_ENDPOINTS'] ? parseEnvJson(env['SERVICE_ENDPOINTS'], 'SERVICE_ENDPOINTS') : [],
      capabilities: env['SERVICE_CAPABILITIES'] ? parseEnvJson(env['SERVICE_CAPABILITIES'], 'SERVICE_CAPABILITIES') : [],
      metadata: env['SERVICE_METADATA'] ? parseEnvJson(env['SERVICE_METADATA'], 'SERVICE_METADATA') : {},
    },
    security: {
      authenticationEnabled: env['SECURITY_AUTH_ENABLED'] !== 'false',
      encryptionMode: (env['SECURITY_ENCRYPTION_MODE'] as 'disabled' | 'selective' | 'required') || 'selective',
      keyRotationIntervalMs: parseInt(env['SECURITY_KEY_ROTATION_INTERVAL_MS'] || '86400000', 10),
      sessionTimeoutMs: parseInt(env['SECURITY_SESSION_TIMEOUT_MS'] || '3600000', 10),
    },
    registry: {
      backend: (env['REGISTRY_BACKEND'] as 'memory' | 'redis') || 'memory',
      redis: env['REDIS_HOST'] ? {
        driver: (env['REDIS_DRIVER'] as 'oneunit' | 'ioredis' | 'node-redis' | 'auto') || 'auto',
        host: env['REDIS_HOST'],
        port: parseInt(env['REDIS_PORT'] || '6379', 10),
        password: env['REDIS_PASSWORD'],
        db: parseInt(env['REDIS_DB'] || '0', 10),
        tls: env['REDIS_TLS'] === 'true',
        keyPrefix: env['REDIS_KEY_PREFIX'],
      } : undefined,
      ttlMs: parseInt(env['REGISTRY_TTL_MS'] || '30000', 10),
      heartbeatIntervalMs: parseInt(env['REGISTRY_HEARTBEAT_INTERVAL_MS'] || '10000', 10),
      healthCheckIntervalMs: parseInt(env['REGISTRY_HEALTH_CHECK_INTERVAL_MS'] || '30000', 10),
      maxServices: parseInt(env['REGISTRY_MAX_SERVICES'] || '1000', 10),
    },
    auth: {
      type: (env['AUTH_TYPE'] as 'allowlist' | 'rbac' | 'composite') || 'allowlist',
      entries: env['AUTH_ENTRIES'] ? JSON.parse(env['AUTH_ENTRIES']) : [],
      defaultPolicy: (env['AUTH_DEFAULT_POLICY'] as 'allow' | 'deny') || 'deny',
      roles: env['AUTH_ROLES'] ? JSON.parse(env['AUTH_ROLES']) : undefined,
      serviceRoles: env['AUTH_SERVICE_ROLES'] ? JSON.parse(env['AUTH_SERVICE_ROLES']) : undefined,
    },
    observability: {
      logging: env['OBSERVABILITY_LOGGING'] !== 'false',
      metrics: env['OBSERVABILITY_METRICS'] !== 'false',
      tracing: env['OBSERVABILITY_TRACING'] !== 'false',
      audit: env['OBSERVABILITY_AUDIT'] !== 'false',
      logLevel: (env['OBSERVABILITY_LOG_LEVEL'] as 'trace' | 'debug' | 'info' | 'warn' | 'error') || 'info',
      prettyLogs: env['OBSERVABILITY_PRETTY_LOGS'] === 'true',
    },
    crypto: {
      rootKey: env['CRYPTO_ROOT_KEY'] || '',
      keyRotationInterval: parseInt(env['CRYPTO_KEY_ROTATION_INTERVAL'] || '86400000', 10),
      sessionTimeout: parseInt(env['CRYPTO_SESSION_TIMEOUT'] || '3600000', 10),
      algorithm: (env['CRYPTO_ALGORITHM'] as 'aes-256-gcm' | 'chacha20-poly1305') || 'aes-256-gcm',
      keyDerivation: (env['CRYPTO_KEY_DERIVATION'] as 'hkdf-sha256' | 'pbkdf2') || 'hkdf-sha256',
    },
    adapters: {
      kafka: {
        enabled: parseBooleanEnv(env['KAFKA_ENABLED'], false),
        driver: (env['KAFKA_DRIVER'] as 'oneunit' | 'kafkajs' | 'auto') || 'auto',
        brokers: env['KAFKA_BROKERS'] ? env['KAFKA_BROKERS'].split(',') : ['localhost:9092'],
        clientId: env['KAFKA_CLIENT_ID'] || 'microservice',
        topics: {
          prefix: env['KAFKA_TOPIC_PREFIX'] || 'microservice',
        },
      },
      nats: {
        enabled: parseBooleanEnv(env['NATS_ENABLED'], false),
        servers: env['NATS_SERVERS'] ? env['NATS_SERVERS'].split(',') : ['nats://localhost:4222'],
      },
      tcp: {
        enabled: parseBooleanEnv(env['TCP_ENABLED'], false),
        host: env['TCP_HOST'] || '0.0.0.0',
        port: parseInt(env['TCP_PORT'] || '8080', 10),
      },
      udp: {
        enabled: parseBooleanEnv(env['UDP_ENABLED'], false),
        host: env['UDP_HOST'] || '0.0.0.0',
        port: parseInt(env['UDP_PORT'] || '8081', 10),
      },
      trpc: {
        enabled: parseBooleanEnv(env['TRPC_ENABLED'], false),
        endpoint: env['TRPC_ENDPOINT'] || 'http://localhost:3000/trpc',
      },
      grpc: {
        enabled: parseBooleanEnv(env['GRPC_ENABLED'], false),
        endpoint: env['GRPC_ENDPOINT'] || 'localhost:50051',
      },
      connect: {
        enabled: parseBooleanEnv(env['CONNECT_ENABLED'], false),
        endpoint: env['CONNECT_ENDPOINT'] || 'http://localhost:3000',
      },
    },
  };
}

export function createDefaultConfig(overrides: DeepPartial<MicroserviceConfig> = {}): MicroserviceConfig {
  return mergeConfig(loadConfig(), overrides);
}


export function createConfigFile(
  configPath: string = 'config.json',
  overrides: DeepPartial<MicroserviceConfig> = {},
): string {
  if (existsSync(configPath)) return configPath;

  const rootKey = process.env['CRYPTO_ROOT_KEY'];
  if (!rootKey || rootKey.length < 32) {
    throw new Error(
      'CRYPTO_ROOT_KEY environment variable is required (>= 32 chars) to create a config file. Set it explicitly before calling createConfigFile().',
    );
  }

  const config = createDefaultConfig(overrides);
  mkdirSync(dirname(resolve(process.cwd(), configPath)), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  return configPath;
}

/**
 * Alias of {@link createConfigFile} that reads better at call sites where the
 * intent is "make sure a config file exists" rather than "create one".
 */
export const ensureConfigFile = createConfigFile;
