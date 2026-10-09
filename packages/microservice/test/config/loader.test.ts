import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig, buildConfigFromEnv } from '../../src/config/loader.js';
import { MicroserviceConfig } from '../../src/config/schema.js';

describe('Config Loader', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('buildConfigFromEnv', () => {
    it('should build config from environment variables with defaults', () => {
      process.env.SERVICE_NAME = 'test-service';
      process.env.SERVICE_ID = '123e4567-e89b-12d3-a456-426614174000';

      const config = buildConfigFromEnv();

      expect(config.service.name).toBe('test-service');
      expect(config.service.id).toBe('123e4567-e89b-12d3-a456-426614174000');
      expect(config.service.instanceId).toBeDefined();
      expect(config.security.authenticationEnabled).toBe(true);
      expect(config.security.encryptionMode).toBe('selective');
      expect(config.registry.backend).toBe('memory');
      expect(config.auth.type).toBe('allowlist');
      expect(config.auth.defaultPolicy).toBe('deny');
      expect(config.observability.logging).toBe(true);
      expect(config.crypto.algorithm).toBe('aes-256-gcm');
    });

    it('should parse boolean env vars correctly', () => {
      process.env.SECURITY_AUTH_ENABLED = 'false';
      process.env.OBSERVABILITY_LOGGING = 'false';
      process.env.OBSERVABILITY_PRETTY_LOGS = 'true';

      const config = buildConfigFromEnv();

      expect(config.security.authenticationEnabled).toBe(false);
      expect(config.observability.logging).toBe(false);
      expect(config.observability.prettyLogs).toBe(true);
    });

    it('should parse numeric env vars correctly', () => {
      process.env.SECURITY_KEY_ROTATION_INTERVAL_MS = '7200000';
      process.env.REGISTRY_TTL_MS = '60000';
      process.env.CRYPTO_KEY_ROTATION_INTERVAL = '3600000';

      const config = buildConfigFromEnv();

      expect(config.security.keyRotationIntervalMs).toBe(7200000);
      expect(config.registry.ttlMs).toBe(60000);
      expect(config.crypto.keyRotationInterval).toBe(3600000);
    });

    it('should parse JSON env vars for complex objects', () => {
      process.env.SERVICE_CREDENTIALS = JSON.stringify({ type: 'jwt', jwtSecret: 'secret', issuedAt: Date.now(), issuer: 'test' });
      process.env.SERVICE_ENDPOINTS = JSON.stringify([{ protocol: 'tcp', host: 'localhost', port: 8080 }]);
      process.env.SERVICE_CAPABILITIES = JSON.stringify(['rpc', 'messaging']);
      process.env.AUTH_ENTRIES = JSON.stringify([{ serviceId: 'svc1', allowedOperations: ['read'] }]);
      process.env.AUTH_ROLES = JSON.stringify({ admin: ['read', 'write'] });

      const config = buildConfigFromEnv();

      expect(config.service.credentials).toEqual({ type: 'jwt', jwtSecret: 'secret', issuedAt: expect.any(Number), issuer: 'test' });
      expect(config.service.endpoints).toEqual([{ protocol: 'tcp', host: 'localhost', port: 8080 }]);
      expect(config.service.capabilities).toEqual(['rpc', 'messaging']);
      expect(config.auth.entries).toEqual([{ serviceId: 'svc1', allowedOperations: ['read'] }]);
      expect(config.auth.roles).toEqual({ admin: ['read', 'write'] });
    });

    it('should build redis config when REDIS_HOST is set', () => {
      process.env.REDIS_HOST = 'redis-server';
      process.env.REDIS_PORT = '6380';
      process.env.REDIS_PASSWORD = 'secret';
      process.env.REDIS_DB = '2';
      process.env.REDIS_TLS = 'true';
      process.env.REDIS_DRIVER = 'ioredis';
      process.env.REDIS_KEY_PREFIX = 'myapp:';

      const config = buildConfigFromEnv();

      expect(config.registry.backend).toBe('memory');
      expect(config.registry.redis).toEqual({
        driver: 'ioredis',
        host: 'redis-server',
        port: 6380,
        password: 'secret',
        db: 2,
        tls: true,
        keyPrefix: 'myapp:',
      });
    });

    it('should build kafka adapter config from env', () => {
      process.env.KAFKA_ENABLED = 'true';
      process.env.KAFKA_DRIVER = 'kafkajs';
      process.env.KAFKA_BROKERS = 'broker1:9092,broker2:9092';
      process.env.KAFKA_CLIENT_ID = 'my-client';
      process.env.KAFKA_TOPIC_PREFIX = 'myapp';

      const config = buildConfigFromEnv();

      expect(config.adapters.kafka.enabled).toBe(true);
      expect(config.adapters.kafka.driver).toBe('kafkajs');
      expect(config.adapters.kafka.brokers).toEqual(['broker1:9092', 'broker2:9092']);
      expect(config.adapters.kafka.clientId).toBe('my-client');
      expect(config.adapters.kafka.topics.prefix).toBe('myapp');
    });

    it('should build nats adapter config from env', () => {
      process.env.NATS_ENABLED = 'true';
      process.env.NATS_SERVERS = 'nats://server1:4222,nats://server2:4222';

      const config = buildConfigFromEnv();

      expect(config.adapters.nats.enabled).toBe(true);
      expect(config.adapters.nats.servers).toEqual(['nats://server1:4222', 'nats://server2:4222']);
    });

    it('should build tcp/udp adapter configs from env', () => {
      process.env.TCP_ENABLED = 'true';
      process.env.TCP_HOST = '127.0.0.1';
      process.env.TCP_PORT = '9090';
      process.env.UDP_ENABLED = 'true';
      process.env.UDP_PORT = '9091';

      const config = buildConfigFromEnv();

      expect(config.adapters.tcp.enabled).toBe(true);
      expect(config.adapters.tcp.host).toBe('127.0.0.1');
      expect(config.adapters.tcp.port).toBe(9090);
      expect(config.adapters.udp.enabled).toBe(true);
      expect(config.adapters.udp.port).toBe(9091);
    });

    it('should build rpc adapter configs from env', () => {
      process.env.TRPC_ENABLED = 'true';
      process.env.TRPC_ENDPOINT = 'http://localhost:4000/trpc';
      process.env.GRPC_ENABLED = 'true';
      process.env.GRPC_ENDPOINT = 'localhost:50052';
      process.env.CONNECT_ENABLED = 'true';
      process.env.CONNECT_ENDPOINT = 'http://localhost:4000';

      const config = buildConfigFromEnv();

      expect(config.adapters.trpc.enabled).toBe(true);
      expect(config.adapters.trpc.endpoint).toBe('http://localhost:4000/trpc');
      expect(config.adapters.grpc.enabled).toBe(true);
      expect(config.adapters.grpc.endpoint).toBe('localhost:50052');
      expect(config.adapters.connect.enabled).toBe(true);
      expect(config.adapters.connect.endpoint).toBe('http://localhost:4000');
    });
  });

  describe('loadConfig', () => {
    it('should throw when config file does not exist and no env vars set', () => {
      // Remove all relevant env vars
      delete process.env.CONFIG_PATH;
      delete process.env.SERVICE_NAME;
      delete process.env.SERVICE_ID;

      expect(() => loadConfig('/nonexistent/path/config.json')).toThrow();
    });

    it('should load config from file when it exists', () => {
      const fs = require('fs');
      const path = '/tmp/test-config.json';
      const validConfig = {
        service: { id: '123e4567-e89b-12d3-a456-426614174000', name: 'file-service' },
        security: {},
        registry: {},
        auth: {},
        observability: {},
        crypto: { rootKey: 'a'.repeat(32) },
      };
      fs.writeFileSync(path, JSON.stringify(validConfig));

      const config = loadConfig(path);

      expect(config.service.name).toBe('file-service');
      fs.unlinkSync(path);
    });

    it('should throw with actionable error for invalid config file', () => {
      const fs = require('fs');
      const path = '/tmp/invalid-config.json';
      fs.writeFileSync(path, JSON.stringify({ service: { name: 'test' } })); // missing required fields

      expect(() => loadConfig(path)).toThrow('Invalid configuration:');

      fs.unlinkSync(path);
    });

    it('should throw with actionable error for malformed JSON', () => {
      const fs = require('fs');
      const path = '/tmp/malformed-config.json';
      fs.writeFileSync(path, '{ invalid json }');

      expect(() => loadConfig(path)).toThrow('Failed to load config');

      fs.unlinkSync(path);
    });
  });
});