import { z } from 'zod';

export const TlsConfigSchema = z.object({
  cert: z.string(),
  key: z.string(),
  ca: z.string().optional(),
  requestCert: z.boolean().default(false),
  rejectUnauthorized: z.boolean().default(true),
});

export const RedisConfigSchema = z.object({
  driver: z.enum(['oneunit', 'ioredis', 'node-redis', 'auto']).default('auto'),
  host: z.string().default('localhost'),
  port: z.number().int().positive().default(6379),
  password: z.string().optional(),
  db: z.number().default(0),
  tls: z.boolean().default(false),
  keyPrefix: z.string().optional(),
  sentinels: z.array(z.object({
    host: z.string(),
    port: z.number().int().positive(),
  })).optional(),
  sentinelName: z.string().optional(),
  sentinelPassword: z.string().optional(),
});

export const ServiceCredentialsSchema = z.object({
  type: z.enum(['x509', 'jwt', 'api-key', 'mtls']),
  certificate: z.string().optional(),
  privateKey: z.string().optional(),
  jwtSecret: z.string().optional(),
  apiKey: z.string().optional(),
  caCert: z.string().optional(),
  expiresAt: z.number().optional(),
  issuedAt: z.number(),
  issuer: z.string(),
});

export const ServiceEndpointSchema = z.object({
  protocol: z.enum(['tcp', 'udp', 'trpc', 'grpc', 'connect', 'kafka', 'nats']),
  host: z.string(),
  port: z.number().int().positive(),
  tls: z.boolean().default(false),
});

export const ServiceConfigSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  instanceId: z.string().uuid().optional().default(() => crypto.randomUUID()),
  credentials: ServiceCredentialsSchema.optional(),
  endpoints: z.array(ServiceEndpointSchema).default([]),
  capabilities: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
});

export const CryptoConfigSchema = z.object({
  rootKey: z.string().min(32),
  keyRotationInterval: z.number().default(24 * 60 * 60 * 1000),
  sessionTimeout: z.number().default(60 * 60 * 1000),
  algorithm: z.enum(['aes-256-gcm', 'chacha20-poly1305']).default('aes-256-gcm'),
  keyDerivation: z.enum(['hkdf-sha256', 'pbkdf2']).default('hkdf-sha256'),
});

export const SecurityConfigSchema = z.object({
  authenticationEnabled: z.boolean().default(true),
  encryptionMode: z.enum(['disabled', 'selective', 'required']).default('selective'),
  keyRotationIntervalMs: z.number().default(24 * 60 * 60 * 1000),
  sessionTimeoutMs: z.number().default(60 * 60 * 1000),
});

export const RegistryConfigSchema = z.object({
  backend: z.enum(['memory', 'redis']).default('memory'),
  redis: RedisConfigSchema.optional(),
  ttlMs: z.number().default(30000),
  heartbeatIntervalMs: z.number().default(10000),
  healthCheckIntervalMs: z.number().default(30000),
  maxServices: z.number().default(1000),
});

export const AuthConfigSchema = z.object({
  type: z.enum(['allowlist', 'rbac', 'composite']).default('allowlist'),
  entries: z.array(z.object({
    serviceId: z.string(),
    allowedOperations: z.array(z.string()),
    allowedResources: z.array(z.string()).optional(),
    allowedTargets: z.array(z.string()).optional(),
  })).default([]),
  defaultPolicy: z.enum(['allow', 'deny']).default('deny'),
  roles: z.record(z.array(z.string())).optional(),
  serviceRoles: z.record(z.array(z.string())).optional(),
});

export const ServiceAllowlistEntrySchema = z.object({
  serviceId: z.string(),
  serviceName: z.string().optional(),
  allowedProtocols: z.array(z.string()).default([]),
  allowedMethods: z.array(z.string()).optional(),
  maxMessageSize: z.number().optional(),
});

export type ServiceAllowlistEntry = z.infer<typeof ServiceAllowlistEntrySchema>;

export const KafkaAdapterConfigSchema = z.object({
  enabled: z.boolean().default(false),
  driver: z.enum(['oneunit', 'kafkajs', 'auto']).default('auto'),
  brokers: z.array(z.string()).default(['localhost:9092']),
  clientId: z.string().default('microservice'),
  topics: z.object({
    prefix: z.string().default('microservice'),
  }).default({ prefix: 'microservice' }),
  producer: z.record(z.unknown()).optional(),
  consumer: z.record(z.unknown()).optional(),
  security: z.object({
    ssl: z.boolean().default(false),
    sasl: z.object({
      mechanism: z.string().default('plain'),
      username: z.string(),
      password: z.string(),
    }).optional(),
  }).optional(),
});

export const NatsAdapterConfigSchema = z.object({
  enabled: z.boolean().default(false),
  servers: z.array(z.string()).default(['nats://localhost:4222']),
  clientName: z.string().optional(),
  subjects: z.object({
    prefix: z.string().default('microservice'),
  }).default({ prefix: 'microservice' }),
  jetstream: z.object({
    enabled: z.boolean().default(false),
    streamName: z.string().optional(),
  }).optional(),
  auth: z.object({
    user: z.string().optional(),
    pass: z.string().optional(),
    token: z.string().optional(),
    nkey: z.string().optional(),
    creds: z.string().optional(),
  }).optional(),
  tls: z.boolean().default(false),
});

export const TcpAdapterConfigSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default('0.0.0.0'),
  port: z.number().int().positive().default(8080),
  tls: z.boolean().default(false),
  cert: z.string().optional(),
  key: z.string().optional(),
  ca: z.string().optional(),
  maxFrameSize: z.number().default(16 * 1024 * 1024),
  connectionTimeout: z.number().default(5000),
  idleTimeout: z.number().default(60000),
});

export const UdpAdapterConfigSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default('0.0.0.0'),
  port: z.number().int().positive().default(8081),
  maxPacketSize: z.number().default(65507),
  ttl: z.number().default(1),
  multicast: z.object({
    address: z.string(),
    interface: z.string().optional(),
  }).optional(),
});

export const TrpcAdapterConfigSchema = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().default('http://localhost:3000/trpc'),
  router: z.record(z.unknown()).optional(),
  cors: z.boolean().default(false),
});

export const GrpcAdapterConfigSchema = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().default('localhost:50051'),
  protoPath: z.string().default(''),
  packageName: z.string().default(''),
  credentials: z.any().optional(),
  tls: z.boolean().default(false),
});

export const ConnectAdapterConfigSchema = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().default('http://localhost:3000'),
  transport: z.any().optional(),
  services: z.record(z.unknown()).optional(),
  interceptors: z.array(z.any()).optional(),
});

export const AdaptersConfigSchema = z.object({
  kafka: KafkaAdapterConfigSchema.default({}),
  nats: NatsAdapterConfigSchema.default({}),
  tcp: TcpAdapterConfigSchema.default({}),
  udp: UdpAdapterConfigSchema.default({}),
  trpc: TrpcAdapterConfigSchema.default({}),
  grpc: GrpcAdapterConfigSchema.default({}),
  connect: ConnectAdapterConfigSchema.default({}),
});

export type KafkaAdapterConfig = z.infer<typeof KafkaAdapterConfigSchema>;
export type NatsAdapterConfig = z.infer<typeof NatsAdapterConfigSchema>;
export type TcpAdapterConfig = z.infer<typeof TcpAdapterConfigSchema>;
export type UdpAdapterConfig = z.infer<typeof UdpAdapterConfigSchema>;
export type TrpcAdapterConfig = z.infer<typeof TrpcAdapterConfigSchema>;
export type GrpcAdapterConfig = z.infer<typeof GrpcAdapterConfigSchema>;
export type ConnectAdapterConfig = z.infer<typeof ConnectAdapterConfigSchema>;
export type AdaptersConfig = z.infer<typeof AdaptersConfigSchema>;

export const ObservabilityConfigSchema = z.object({
  logging: z.boolean().default(true),
  metrics: z.boolean().default(true),
  tracing: z.boolean().default(true),
  audit: z.boolean().default(true),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  prettyLogs: z.boolean().default(false),
});

export const MicroserviceConfigSchema = z.object({
  service: ServiceConfigSchema,
  security: SecurityConfigSchema,
  registry: RegistryConfigSchema,
  auth: AuthConfigSchema,
  observability: ObservabilityConfigSchema,
  crypto: CryptoConfigSchema,
  adapters: AdaptersConfigSchema.optional(),
});

export type MicroserviceConfig = z.infer<typeof MicroserviceConfigSchema>;
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
export type TlsConfig = z.infer<typeof TlsConfigSchema>;
export type RedisConfig = z.infer<typeof RedisConfigSchema>;
export type ServiceCredentials = z.infer<typeof ServiceCredentialsSchema>;
export type ServiceEndpoint = z.infer<typeof ServiceEndpointSchema>;
export type CryptoConfig = z.infer<typeof CryptoConfigSchema>;
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;
export type RegistryConfig = z.infer<typeof RegistryConfigSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;