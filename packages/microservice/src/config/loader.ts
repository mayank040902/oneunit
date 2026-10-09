import { readFileSync } from 'fs';
import { resolve } from 'path';
import { MicroserviceConfigSchema, MicroserviceConfig } from './schema.js';

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

export function buildConfigFromEnv(): Record<string, unknown> {
  const env = process.env;
  return {
    service: {
      id: env['SERVICE_ID'] || crypto.randomUUID(),
      name: env['SERVICE_NAME'] || 'microservice-server',
      instanceId: env['SERVICE_INSTANCE_ID'] || crypto.randomUUID(),
      credentials: env['SERVICE_CREDENTIALS'] ? JSON.parse(env['SERVICE_CREDENTIALS']) : undefined,
      endpoints: env['SERVICE_ENDPOINTS'] ? JSON.parse(env['SERVICE_ENDPOINTS']) : [],
      capabilities: env['SERVICE_CAPABILITIES'] ? JSON.parse(env['SERVICE_CAPABILITIES']) : [],
      metadata: env['SERVICE_METADATA'] ? JSON.parse(env['SERVICE_METADATA']) : {},
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
        enabled: env['KAFKA_ENABLED'] === 'true',
        driver: (env['KAFKA_DRIVER'] as 'oneunit' | 'kafkajs' | 'auto') || 'auto',
        brokers: env['KAFKA_BROKERS'] ? env['KAFKA_BROKERS'].split(',') : ['localhost:9092'],
        clientId: env['KAFKA_CLIENT_ID'] || 'microservice',
        topics: {
          prefix: env['KAFKA_TOPIC_PREFIX'] || 'microservice',
        },
      },
      nats: {
        enabled: env['NATS_ENABLED'] === 'true',
        servers: env['NATS_SERVERS'] ? env['NATS_SERVERS'].split(',') : ['nats://localhost:4222'],
      },
      tcp: {
        enabled: env['TCP_ENABLED'] === 'true',
        host: env['TCP_HOST'] || '0.0.0.0',
        port: parseInt(env['TCP_PORT'] || '8080', 10),
      },
      udp: {
        enabled: env['UDP_ENABLED'] === 'true',
        host: env['UDP_HOST'] || '0.0.0.0',
        port: parseInt(env['UDP_PORT'] || '8081', 10),
      },
      trpc: {
        enabled: env['TRPC_ENABLED'] === 'true',
        endpoint: env['TRPC_ENDPOINT'] || 'http://localhost:3000/trpc',
      },
      grpc: {
        enabled: env['GRPC_ENABLED'] === 'true',
        endpoint: env['GRPC_ENDPOINT'] || 'localhost:50051',
      },
      connect: {
        enabled: env['CONNECT_ENABLED'] === 'true',
        endpoint: env['CONNECT_ENDPOINT'] || 'http://localhost:3000',
      },
    },
  };
}

export function createDefaultConfig(overrides: Partial<MicroserviceConfig> = {}): MicroserviceConfig {
  const defaults = loadConfig();
  return MicroserviceConfigSchema.parse({ ...defaults, ...overrides });
}