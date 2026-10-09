import { describe, it, expect } from 'vitest';
import {
  MicroserviceConfigSchema,
  ServiceConfigSchema,
  RedisConfigSchema,
  KafkaAdapterConfigSchema,
  NatsAdapterConfigSchema,
  TcpAdapterConfigSchema,
  UdpAdapterConfigSchema,
  SecurityConfigSchema,
  RegistryConfigSchema,
  AuthConfigSchema,
  CryptoConfigSchema,
  ObservabilityConfigSchema,
  ServiceCredentialsSchema,
  ServiceEndpointSchema,
} from '../../src/config/schema.js';

describe('Config Schema Validation', () => {
  describe('ServiceConfigSchema', () => {
    it('should accept valid service config', () => {
      const validConfig = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: 'test-service',
        instanceId: '123e4567-e89b-12d3-a456-426614174001',
        credentials: undefined,
        endpoints: [],
        capabilities: [],
        metadata: {},
      };
      const result = ServiceConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it('should reject invalid UUID for id', () => {
      const invalidConfig = {
        id: 'not-a-uuid',
        name: 'test-service',
      };
      const result = ServiceConfigSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some(i => i.path.includes('id'))).toBe(true);
      }
    });

    it('should reject empty name', () => {
      const invalidConfig = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: '',
      };
      const result = ServiceConfigSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });

    it('should generate instanceId when not provided', () => {
      const config = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: 'test-service',
      };
      const result = ServiceConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.instanceId).toBeDefined();
      }
    });

    it('should apply default empty arrays for endpoints, capabilities, metadata', () => {
      const config = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: 'test-service',
      };
      const result = ServiceConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.endpoints).toEqual([]);
        expect(result.data.capabilities).toEqual([]);
        expect(result.data.metadata).toEqual({});
      }
    });
  });

  describe('RedisConfigSchema', () => {
    it('should accept valid redis config with all fields', () => {
      const validConfig = {
        driver: 'ioredis',
        host: 'localhost',
        port: 6379,
        password: 'secret',
        db: 1,
        tls: true,
        keyPrefix: 'test:',
        sentinels: [{ host: 'sentinel1', port: 26379 }],
        sentinelName: 'mymaster',
        sentinelPassword: 'sentinel-secret',
      };
      const result = RedisConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it('should default driver to auto', () => {
      const config = { host: 'localhost', port: 6379 };
      const result = RedisConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.driver).toBe('auto');
      }
    });

    it('should default host to localhost', () => {
      const config = { port: 6379 };
      const result = RedisConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.host).toBe('localhost');
      }
    });

    it('should default port to 6379', () => {
      const config = { host: 'localhost' };
      const result = RedisConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.port).toBe(6379);
      }
    });

    it('should reject invalid driver value', () => {
      const config = { driver: 'invalid-driver', host: 'localhost', port: 6379 };
      const result = RedisConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it('should reject zero port', () => {
      const config = { host: 'localhost', port: 0 };
      const result = RedisConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe('KafkaAdapterConfigSchema', () => {
    it('should accept valid kafka config', () => {
      const validConfig = {
        enabled: true,
        driver: 'oneunit',
        brokers: ['broker1:9092', 'broker2:9092'],
        clientId: 'my-client',
        topics: { prefix: 'myapp' },
        security: {
          ssl: true,
          sasl: {
            mechanism: 'scram-sha-256',
            username: 'user',
            password: 'pass',
          },
        },
      };
      const result = KafkaAdapterConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it('should default enabled to false', () => {
      const config = { brokers: ['localhost:9092'] };
      const result = KafkaAdapterConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(false);
      }
    });

    it('should default driver to auto', () => {
      const config = { brokers: ['localhost:9092'] };
      const result = KafkaAdapterConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.driver).toBe('auto');
      }
    });

    it('should default brokers to localhost:9092', () => {
      const config = {};
      const result = KafkaAdapterConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.brokers).toEqual(['localhost:9092']);
      }
    });

    it('should reject invalid driver', () => {
      const config = { driver: 'invalid', brokers: ['localhost:9092'] };
      const result = KafkaAdapterConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it('should require sasl password when sasl is provided', () => {
      const config = {
        brokers: ['localhost:9092'],
        security: {
          sasl: {
            mechanism: 'plain',
            username: 'user',
          },
        },
      };
      const result = KafkaAdapterConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe('NatsAdapterConfigSchema', () => {
    it('should accept valid nats config with jetstream', () => {
      const validConfig = {
        enabled: true,
        servers: ['nats://server1:4222'],
        clientName: 'my-client',
        subjects: { prefix: 'myapp' },
        jetstream: { enabled: true, streamName: 'events' },
        auth: { user: 'user', pass: 'pass' },
        tls: true,
      };
      const result = NatsAdapterConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it('should default servers to nats://localhost:4222', () => {
      const config = {};
      const result = NatsAdapterConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.servers).toEqual(['nats://localhost:4222']);
      }
    });

    it('should default jetstream enabled to false', () => {
      const config = { jetstream: { enabled: true } };
      const result = NatsAdapterConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.jetstream?.enabled).toBe(true);
      }
    });
  });

  describe('TcpAdapterConfigSchema', () => {
    it('should accept valid tcp config with TLS', () => {
      const validConfig = {
        enabled: true,
        host: '0.0.0.0',
        port: 8080,
        tls: true,
        cert: '/path/to/cert',
        key: '/path/to/key',
        ca: '/path/to/ca',
        maxFrameSize: 1024 * 1024,
        connectionTimeout: 10000,
        idleTimeout: 120000,
      };
      const result = TcpAdapterConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it('should default maxFrameSize to 16MB', () => {
      const config = { enabled: true };
      const result = TcpAdapterConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.maxFrameSize).toBe(16 * 1024 * 1024);
      }
    });

    it('should reject zero or negative port', () => {
      const config = { port: 0 };
      const result = TcpAdapterConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe('UdpAdapterConfigSchema', () => {
    it('should accept valid udp config with multicast', () => {
      const validConfig = {
        enabled: true,
        host: '0.0.0.0',
        port: 8081,
        maxPacketSize: 65507,
        ttl: 2,
        multicast: { address: '239.0.0.1', interface: 'eth0' },
      };
      const result = UdpAdapterConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it('should default maxPacketSize to 65507', () => {
      const config = { enabled: true };
      const result = UdpAdapterConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.maxPacketSize).toBe(65507);
      }
    });
  });

  describe('SecurityConfigSchema', () => {
    it('should accept valid security config', () => {
      const validConfig = {
        authenticationEnabled: true,
        encryptionMode: 'required',
        keyRotationIntervalMs: 3600000,
        sessionTimeoutMs: 1800000,
      };
      const result = SecurityConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it('should default authenticationEnabled to true', () => {
      const config = {};
      const result = SecurityConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.authenticationEnabled).toBe(true);
      }
    });

    it('should default encryptionMode to selective', () => {
      const config = {};
      const result = SecurityConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.encryptionMode).toBe('selective');
      }
    });

    it('should reject invalid encryptionMode', () => {
      const config = { encryptionMode: 'invalid' };
      const result = SecurityConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe('RegistryConfigSchema', () => {
    it('should accept valid registry config with redis backend', () => {
      const validConfig = {
        backend: 'redis',
        redis: { host: 'localhost', port: 6379 },
        ttlMs: 60000,
        heartbeatIntervalMs: 20000,
        healthCheckIntervalMs: 60000,
        maxServices: 5000,
      };
      const result = RegistryConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it('should default backend to memory', () => {
      const config = {};
      const result = RegistryConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.backend).toBe('memory');
      }
    });

    it('should reject invalid backend', () => {
      const config = { backend: 'invalid' };
      const result = RegistryConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe('AuthConfigSchema', () => {
    it('should accept valid auth config with allowlist entries', () => {
      const validConfig = {
        type: 'allowlist',
        entries: [
          { serviceId: 'service-1', allowedOperations: ['read', 'write'] },
          { serviceId: 'service-2', allowedOperations: ['read'], allowedResources: ['resource-1'] },
        ],
        defaultPolicy: 'deny',
        roles: { admin: ['read', 'write', 'delete'] },
        serviceRoles: { 'service-1': ['admin'] },
      };
      const result = AuthConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it('should default type to allowlist', () => {
      const config = {};
      const result = AuthConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('allowlist');
      }
    });

    it('should default defaultPolicy to deny', () => {
      const config = {};
      const result = AuthConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.defaultPolicy).toBe('deny');
      }
    });

    it('should reject invalid defaultPolicy', () => {
      const config = { defaultPolicy: 'invalid' };
      const result = AuthConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe('CryptoConfigSchema', () => {
    it('should accept valid crypto config', () => {
      const validConfig = {
        rootKey: 'a'.repeat(32),
        keyRotationInterval: 86400000,
        sessionTimeout: 3600000,
        algorithm: 'aes-256-gcm',
        keyDerivation: 'hkdf-sha256',
      };
      const result = CryptoConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it('should reject rootKey shorter than 32 characters', () => {
      const config = { rootKey: 'short' };
      const result = CryptoConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it('should default algorithm to aes-256-gcm', () => {
      const config = { rootKey: 'a'.repeat(32) };
      const result = CryptoConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.algorithm).toBe('aes-256-gcm');
      }
    });

    it('should reject invalid algorithm', () => {
      const config = { rootKey: 'a'.repeat(32), algorithm: 'invalid' };
      const result = CryptoConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe('ObservabilityConfigSchema', () => {
    it('should accept valid observability config', () => {
      const validConfig = {
        logging: true,
        metrics: true,
        tracing: true,
        audit: true,
        logLevel: 'debug',
        prettyLogs: true,
      };
      const result = ObservabilityConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it('should default logLevel to info', () => {
      const config = {};
      const result = ObservabilityConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.logLevel).toBe('info');
      }
    });

    it('should reject invalid logLevel', () => {
      const config = { logLevel: 'invalid' };
      const result = ObservabilityConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe('ServiceCredentialsSchema', () => {
    it('should accept x509 credentials', () => {
      const validConfig = {
        type: 'x509',
        certificate: 'cert',
        privateKey: 'key',
        caCert: 'ca',
        issuedAt: Date.now(),
        issuer: 'test-issuer',
      };
      const result = ServiceCredentialsSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it('should accept jwt credentials', () => {
      const validConfig = {
        type: 'jwt',
        jwtSecret: 'secret',
        issuedAt: Date.now(),
        issuer: 'test-issuer',
      };
      const result = ServiceCredentialsSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it('should accept api-key credentials', () => {
      const validConfig = {
        type: 'api-key',
        apiKey: 'key123',
        issuedAt: Date.now(),
        issuer: 'test-issuer',
      };
      const result = ServiceCredentialsSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it('should reject invalid type', () => {
      const config = { type: 'invalid', issuedAt: Date.now(), issuer: 'test' };
      const result = ServiceCredentialsSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it('should require issuedAt and issuer', () => {
      const config = { type: 'x509' };
      const result = ServiceCredentialsSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe('ServiceEndpointSchema', () => {
    it('should accept valid endpoint', () => {
      const validConfig = {
        protocol: 'grpc',
        host: 'localhost',
        port: 50051,
        tls: true,
      };
      const result = ServiceEndpointSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it('should reject invalid protocol', () => {
      const config = { protocol: 'invalid', host: 'localhost', port: 50051 };
      const result = ServiceEndpointSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it('should reject non-positive port', () => {
      const config = { protocol: 'tcp', host: 'localhost', port: 0 };
      const result = ServiceEndpointSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe('MicroserviceConfigSchema', () => {
    it('should accept complete valid microservice config', () => {
      const validConfig = {
        service: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          name: 'test-service',
        },
        security: {},
        registry: {},
        auth: {},
        observability: {},
        crypto: { rootKey: 'a'.repeat(32) },
        adapters: {},
      };
      const result = MicroserviceConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it('should reject missing required service config', () => {
      const config = {
        security: {},
        registry: {},
        auth: {},
        observability: {},
        crypto: { rootKey: 'a'.repeat(32) },
      };
      const result = MicroserviceConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it('should reject missing required crypto rootKey', () => {
      const config = {
        service: { id: '123e4567-e89b-12d3-a456-426614174000', name: 'test' },
        security: {},
        registry: {},
        auth: {},
        observability: {},
        crypto: { rootKey: 'short' },
      };
      const result = MicroserviceConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it('should make adapters optional', () => {
      const config = {
        service: { id: '123e4567-e89b-12d3-a456-426614174000', name: 'test' },
        security: {},
        registry: {},
        auth: {},
        observability: {},
        crypto: { rootKey: 'a'.repeat(32) },
      };
      const result = MicroserviceConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });
  });
});