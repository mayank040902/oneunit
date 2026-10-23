// Real-world scenario: a deployment bootstrap script that generates the
// initial config.json for a fresh Kubernetes pod. It reads the root key
// from a mounted secret, picks the service identity from environment
// variables injected by the platform, and writes the file with restrictive
// permissions so the running process cannot be impersonated by other
// users on the host.
//
// Run with:
//   CRYPTO_ROOT_KEY=$(openssl rand -base64 32) \
//   SERVICE_ID=$(uuidgen) \
//   SERVICE_NAME=order-service \
//   REDIS_HOST=redis.cache.svc.cluster.local \
//   REDIS_PASSWORD=*** \
//   node examples/create-config.ts

import { ensureConfigFile } from '@oneunit/microservice';

// The root key is the master secret for the service's envelope encryption.
// It is supplied by the operator (or a secret manager) and never generated
// implicitly by the framework.
const rootKey = process.env['CRYPTO_ROOT_KEY'];
if (!rootKey || rootKey.length < 32) {
  throw new Error(
    'CRYPTO_ROOT_KEY must be set (>= 32 characters) before creating a config file',
  );
}

const serviceId = process.env['SERVICE_ID'];
if (!serviceId) {
  throw new Error('SERVICE_ID must be set');
}

// ensureConfigFile creates ./config.json from validated environment defaults
// only if the file does not already exist. It never overwrites an existing
// file, so a ConfigMap-mounted config is always authoritative.
const path = ensureConfigFile('config.json', {
  service: {
    id: serviceId,
    name: process.env['SERVICE_NAME'] ?? 'order-service',
    endpoints: [
      {
        protocol: 'grpc',
        host: '0.0.0.0',
        port: Number(process.env['GRPC_PORT'] ?? '50051'),
        tls: true,
      },
    ],
    capabilities: ['rpc', 'messaging'],
    metadata: {
      version: process.env['APP_VERSION'] ?? '1.0.0',
      region: process.env['AWS_REGION'] ?? 'us-east-1',
    },
  },
  registry: {
    backend: 'redis',
    redis: {
      host: process.env['REDIS_HOST'] ?? 'localhost',
      port: Number(process.env['REDIS_PORT'] ?? '6379'),
      password: process.env['REDIS_PASSWORD'],
      db: 0,
      tls: process.env['REDIS_TLS'] === 'true',
      keyPrefix: 'oneunit:registry:',
    },
    ttlMs: 30000,
    heartbeatIntervalMs: 10000,
  },
  auth: {
    type: 'allowlist',
    defaultPolicy: 'deny',
  },
  crypto: {
    rootKey,
    algorithm: 'aes-256-gcm',
    keyDerivation: 'hkdf-sha256',
  },
  adapters: {
    kafka: {
      enabled: process.env['KAFKA_ENABLED'] === 'true',
      brokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(','),
      clientId: process.env['SERVICE_NAME'] ?? 'order-service',
      topics: { prefix: 'orders' },
    },
    nats: { enabled: false },
    tcp: { enabled: false },
    udp: { enabled: false },
    trpc: { enabled: false },
    grpc: { enabled: false },
    connect: { enabled: false },
  },
});

console.log('Created or reused', path);