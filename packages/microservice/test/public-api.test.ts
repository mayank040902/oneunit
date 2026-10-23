import { describe, it, expect } from 'vitest';

/**
 * Guards the published surface of the package.
 *
 * Every entry point declared in `package.json#exports` must load without an
 * optional peer dependency installed, and must expose the documented
 * factories/classes. This replaces the previous blanket "import every module"
 * smoke test, which asserted nothing and silently rotted when modules were
 * removed.
 */

const ENTRY_POINTS: Array<{ path: string; load: () => Promise<Record<string, unknown>> }> = [
  {
    path: '.',
    load: () => import('../src/index.js'),
  },
  {
    path: './adapters/logging/pino',
    load: () => import('../src/adapters/logging/pino/index.js'),
  },
  {
    path: './adapters/logging/oneunit',
    load: () => import('../src/adapters/logging/oneunit/index.js'),
  },
  {
    path: './adapters/messaging/kafka',
    load: () => import('../src/adapters/messaging/kafka/index.js'),
  },
  {
    path: './adapters/messaging/nats',
    load: () => import('../src/adapters/messaging/nats/index.js'),
  },
  {
    path: './adapters/messaging/rabbitmq',
    load: () => import('../src/adapters/messaging/rabbitmq/index.js'),
  },
  {
    path: './adapters/rpc/grpc',
    load: () => import('../src/adapters/rpc/grpc/index.js'),
  },
  {
    path: './registry/redis',
    load: () => import('../src/registry/redis/index.js'),
  },
];

const DOCUMENTED_EXPORTS: Record<string, string[]> = {
  '.': [
    'createMicroservice',
    'createRegistry',
    'createServiceIdentity',
    'createAuthorizationPolicy',
    'createLogger',
    'loadConfig',
    'createDefaultConfig',
    'createConfigFile',
    'ensureConfigFile',
    'id',
  ],
  './adapters/logging/pino': ['createPinoLogger'],
  './adapters/logging/oneunit': ['createOneUnitLogger'],
  './adapters/messaging/kafka': ['KafkaTransport', 'createKafkaTransport', 'createKafkaClient'],
  './adapters/messaging/nats': ['NatsTransport'],
  './adapters/messaging/rabbitmq': ['RabbitMQTransport', 'createRabbitMQTransport', 'RabbitMQClient'],
  './adapters/rpc/grpc': ['GrpcTransport'],
  './registry/redis': ['RedisRegistryStore', 'resolveRedisDriver'],
};

describe('published entry points', () => {
  it.each(ENTRY_POINTS)('should load the "$path" entry point without optional peers', async ({ load }) => {
    const mod = await load();

    expect(mod).toBeTypeOf('object');
  });

  it.each(ENTRY_POINTS)('should expose the documented exports of "$path"', async ({ path, load }) => {
    const mod = await load();

    for (const name of DOCUMENTED_EXPORTS[path] ?? []) {
      expect(mod, `${path} should export ${name}`).toHaveProperty(name);
    }
  });
});

describe('package export map', () => {
  it('should declare an entry point for every documented subpath', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

    for (const { path } of ENTRY_POINTS) {
      expect(pkg.exports, `package.json should declare the "${path}" export`).toHaveProperty(path);
    }
  });
});
