import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Transport } from '../../src/core/capabilities.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

;
;
;
;

// Mock all dependencies at the top level
vi.mock('../../src/config/loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/loader.js')>();
  return {
    loadConfig: vi.fn(),
    mergeConfig: actual.mergeConfig,
    buildConfigFromEnv: actual.buildConfigFromEnv,
    createDefaultConfig: actual.createDefaultConfig,
    createConfigFile: vi.fn(),
    ensureConfigFile: vi.fn(),
    writeConfigFile: vi.fn(),
    saveConfig: vi.fn(),
    ensureConfig: vi.fn(),
    generateConfig: vi.fn(),
    autoCreateConfig: vi.fn(),
  };
});
vi.mock('../../src/registry/registry.js', () => ({
  createRegistry: vi.fn(),
  ServiceRegistry: {},
}));
vi.mock('../../src/identity/service-identity.js', () => ({
  createServiceIdentity: vi.fn(),
  ServiceIdentity: {},
}));
vi.mock('../../src/identity/authorization.js', () => ({
  createAuthorizationPolicy: vi.fn(),
  AuthorizationPolicy: {},
}));
vi.mock('../../src/core/lifecycle.js', () => ({
  LifecycleManager: vi.fn(),
  createLifecycleManager: vi.fn(),
}));

import { createMicroservice, MicroserviceApp } from '../../src/core/application.js';
import { loadConfig } from '../../src/config/loader.js';
import { createRegistry } from '../../src/registry/registry.js';
import { createServiceIdentity } from '../../src/identity/service-identity.js';
import { createAuthorizationPolicy } from '../../src/identity/authorization.js';
import { LifecycleManager as MockedLifecycleManager } from '../../src/core/lifecycle.js';

const mockLoadConfig = vi.mocked(loadConfig);
const mockCreateRegistry = vi.mocked(createRegistry);
const mockCreateServiceIdentity = vi.mocked(createServiceIdentity);
const mockCreateAuthorizationPolicy = vi.mocked(createAuthorizationPolicy);
const MockedLifecycleManagerClass = vi.mocked(MockedLifecycleManager);

describe('Application', () => {
  let mockConfig: any;
  let mockRegistry: any;
  let mockIdentity: any;
  let mockAuthorization: any;
  let mockLifecycle: any;
  let mockTransport: Transport;
  let dir: string;
  let originalRootKey: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    
    dir = mkdtempSync(join(tmpdir(), 'oneunit-app-test-'));
    originalRootKey = process.env['CRYPTO_ROOT_KEY'];
    delete process.env['CRYPTO_ROOT_KEY'];
    
    mockConfig = {
      service: {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: 'test-service',
        instanceId: '123e4567-e89b-12d3-a456-426614174001',
        credentials: undefined,
        endpoints: [],
        capabilities: [],
        metadata: {},
      },
      security: { authenticationEnabled: true },
      registry: {
        backend: 'memory',
        ttlMs: 30000,
        heartbeatIntervalMs: 10000,
        healthCheckIntervalMs: 30000,
        maxServices: 1000,
      },
      auth: {
        type: 'allowlist',
        entries: [],
        defaultPolicy: 'deny',
      },
      observability: {},
      crypto: { rootKey: 'a'.repeat(32) },
      adapters: {},
    };

    mockRegistry = {
      register: vi.fn().mockResolvedValue({ leaseId: 'lease-1', serviceId: 'svc-1', instanceId: 'inst-1', expiresAt: Date.now() + 30000, ttlMs: 30000 }),
      deregister: vi.fn().mockResolvedValue(undefined),
      renew: vi.fn().mockResolvedValue(undefined),
    };

    mockIdentity = {
      serviceId: '123e4567-e89b-12d3-a456-426614174000',
      getRegistration: vi.fn().mockReturnValue({ serviceId: 'test', serviceName: 'test-service', instanceId: 'inst-1', endpoints: [], capabilities: [], metadata: {}, registeredAt: Date.now() }),
    };

    mockAuthorization = {
      check: vi.fn().mockResolvedValue(true),
    };

    mockLifecycle = {
      getState: vi.fn().mockReturnValue('initialized'),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      setHooks: vi.fn(),
      registerTransport: vi.fn(),
      unregisterTransport: vi.fn().mockReturnValue(false),
      getTransport: vi.fn(),
      getAllTransports: vi.fn().mockReturnValue([]),
    };

    mockTransport = {
      name: 'test-transport',
      capabilities: {
        requestResponse: true,
        streaming: false,
        publishSubscribe: false,
        durableDelivery: false,
        orderedDelivery: true,
        bidirectional: false,
      },
      start: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      healthCheck: vi.fn().mockResolvedValue({ status: 'healthy', checkedAt: Date.now() }),
    };

    // Setup mock implementations
    mockLoadConfig.mockReturnValue(mockConfig);
    mockCreateRegistry.mockReturnValue(mockRegistry);
    mockCreateServiceIdentity.mockReturnValue(mockIdentity);
    mockCreateAuthorizationPolicy.mockReturnValue(mockAuthorization);
    MockedLifecycleManagerClass.mockImplementation(() => mockLifecycle);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalRootKey === undefined) {
      delete process.env['CRYPTO_ROOT_KEY'];
    } else {
      process.env['CRYPTO_ROOT_KEY'] = originalRootKey;
    }
    vi.useRealTimers();
  });

  describe('createMicroservice', () => {
    it('should create app with all required properties', async () => {
      const app = await createMicroservice({});

      expect(app).toBeDefined();
      expect(app.service).toEqual(mockConfig.service);
      expect(app.config.service.id).toBe(mockConfig.service.id);
      expect(app.config.registry).toEqual(mockConfig.registry);
      expect(app.registry).toBe(mockRegistry);
      expect(app.identity).toBe(mockIdentity);
      expect(app.authorization).toBe(mockAuthorization);
      expect(app.lifecycle).toBe(mockLifecycle);
    });

    it('should NOT call ensureConfigFile during construction (OPS-01)', async () => {
      await createMicroservice({});
      const { createConfigFile, ensureConfigFile } = await import('../../src/config/loader.js');
      expect(createConfigFile).not.toHaveBeenCalled();
      expect(ensureConfigFile).not.toHaveBeenCalled();
    });

    it('should NOT mutate process.env.CRYPTO_ROOT_KEY during construction (OPS-01)', async () => {
      const before = { ...process.env };
      await createMicroservice({});
      const after = { ...process.env };
      expect(before).toEqual(after);
    });

    it('should NOT write config.json to CWD during construction (OPS-01)', async () => {
      const cwdConfig = join(process.cwd(), 'config.json');
      try {
        if (existsSync(cwdConfig)) rmSync(cwdConfig, { force: true });
        await createMicroservice({});
        expect(existsSync(cwdConfig)).toBe(false);
      } finally {
        if (existsSync(cwdConfig)) rmSync(cwdConfig, { force: true });
      }
    });

    it('should load config from file when configPath provided', async () => {
      await createMicroservice({ configPath: '/custom/path.json' });
      expect(mockLoadConfig).toHaveBeenCalledWith('/custom/path.json');
    });

    it('should deep-merge provided config overrides', async () => {
      const overrides = { service: { name: 'overridden-service' } };
      const app = await createMicroservice({ config: overrides });

      // Overrides merge field by field: the service section
      // keeps its other fields and the loaded config is not mutated.
      expect(app.config.service.name).toBe('overridden-service');
      expect(app.config.service.id).toBe(mockConfig.service.id);
      expect(mockConfig.service.name).toBe('test-service');
    });

    it('should replace credential blocks wholesale', async () => {
      const overrides = {
        service: {
          credentials: {
            type: 'jwt',
            jwtSecret: 'secret',
            issuedAt: Date.now(),
            issuer: 'issuer',
          },
        },
      };
      const app = await createMicroservice({ config: overrides });

      expect(app.config.service.credentials?.type).toBe('jwt');
    });

    it('should reject invalid configuration overrides before constructing resources', async () => {
      const overrides = { service: { id: 'not-a-uuid' } };
      await expect(createMicroservice({ config: overrides })).rejects.toThrow(
        /Invalid configuration after merge/
      );
      // No runtime resource was constructed from the invalid config
      expect(mockCreateServiceIdentity).not.toHaveBeenCalled();
    });

    it('should expose a frozen configuration', async () => {
      const app = await createMicroservice({});
      expect(Object.isFrozen(app.config)).toBe(true);
    });

    it('should reject missing crypto.rootKey (OPS-01)', async () => {
      const badConfig = { ...mockConfig, crypto: { rootKey: '' } };
      mockLoadConfig.mockReturnValue(badConfig);
      await expect(createMicroservice({})).rejects.toThrow(/crypto.rootKey/);
    });

    it('should reject short crypto.rootKey (< 32 chars) (OPS-01)', async () => {
      const badConfig = { ...mockConfig, crypto: { rootKey: 'short-key' } };
      mockLoadConfig.mockReturnValue(badConfig);
      await expect(createMicroservice({})).rejects.toThrow(/crypto.rootKey/);
    });

    it('should create service identity with service config', async () => {
      await createMicroservice({});
      expect(mockCreateServiceIdentity).toHaveBeenCalledWith(mockConfig.service);
    });

    it('should create registry with registry config', async () => {
      await createMicroservice({});
      expect(mockCreateRegistry).toHaveBeenCalledWith(mockConfig.registry);
    });

    it('should create authorization with auth config', async () => {
      await createMicroservice({});
      expect(mockCreateAuthorizationPolicy).toHaveBeenCalledWith('allowlist', {
        entries: mockConfig.auth.entries,
        defaultPolicy: mockConfig.auth.defaultPolicy,
        roles: mockConfig.auth.roles,
        serviceRoles: mockConfig.auth.serviceRoles,
        authenticationEnabled: mockConfig.security.authenticationEnabled,
      });
    });

    it('should create lifecycle manager with health check interval', async () => {
      await createMicroservice({});
      expect(MockedLifecycleManagerClass).toHaveBeenCalledWith(30000);
    });
  });

  describe('Registry lease lifecycle (OPS-02/OPS-03)', () => {
    let app: MicroserviceApp;

    beforeEach(async () => {
      app = await createMicroservice({});
    });

    it('should retain the exact lease returned by registry.register()', async () => {
      await app.start();
      expect(mockRegistry.register).toHaveBeenCalledWith(mockIdentity.getRegistration());
      expect(mockRegistry.deregister).not.toHaveBeenCalled();
    });

    it('should deregister using the lease ID, not the service ID (OPS-02)', async () => {
      await app.start();
      const hooks = mockLifecycle.setHooks.mock.calls[0][0];
      await hooks.onStop!();
      expect(mockRegistry.deregister).toHaveBeenCalledWith('lease-1');
      expect(mockRegistry.deregister).not.toHaveBeenCalledWith(mockIdentity.serviceId);
    });

    it('should stop heartbeat renewal before deregistering on stop', async () => {
      vi.useFakeTimers();
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      await app.start();
      expect(setIntervalSpy).toHaveBeenCalled();
      await app.stop();
      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(mockRegistry.deregister).toHaveBeenCalledWith('lease-1');
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      vi.useRealTimers();
    });

    it('should deregister the correct lease immediately on stop (OPS-03)', async () => {
      await app.start();
      await app.stop();
      expect(mockRegistry.deregister).toHaveBeenCalledWith('lease-1');
    });

    it('should be idempotent on stop', async () => {
      await app.start();
      await app.stop();
      await app.stop(); // should not throw
    });

    it('should handle registry registration failure during startup', async () => {
      mockRegistry.register.mockRejectedValueOnce(new Error('Registry unavailable'));
      await expect(app.start()).rejects.toThrow('Registry unavailable');
    });
  });

  describe('MicroserviceApp.start', () => {
    it('should create app with all required properties', async () => {
      const app = await createMicroservice({});

      expect(app).toBeDefined();
      expect(app.service).toEqual(mockConfig.service);
      expect(app.config.service.id).toBe(mockConfig.service.id);
      expect(app.config.registry).toEqual(mockConfig.registry);
      expect(app.registry).toBe(mockRegistry);
      expect(app.identity).toBe(mockIdentity);
      expect(app.authorization).toBe(mockAuthorization);
      expect(app.lifecycle).toBe(mockLifecycle);
    });

    it('should load config from file when configPath provided', async () => {
      await createMicroservice({ configPath: '/custom/path.json' });
      expect(mockLoadConfig).toHaveBeenCalledWith('/custom/path.json');
    });

    it('should deep-merge provided config overrides', async () => {
      const overrides = { service: { name: 'overridden-service' } };
      const app = await createMicroservice({ config: overrides });

      // Overrides merge field by field: the service section
      // keeps its other fields and the loaded config is not mutated.
      expect(app.config.service.name).toBe('overridden-service');
      expect(app.config.service.id).toBe(mockConfig.service.id);
      expect(mockConfig.service.name).toBe('test-service');
    });

    it('should replace credential blocks wholesale', async () => {
      const overrides = {
        service: {
          credentials: {
            type: 'jwt',
            jwtSecret: 'secret',
            issuedAt: Date.now(),
            issuer: 'issuer',
          },
        },
      };
      const app = await createMicroservice({ config: overrides });

      expect(app.config.service.credentials?.type).toBe('jwt');
    });

    it('should reject invalid configuration overrides before constructing resources', async () => {
      const overrides = { service: { id: 'not-a-uuid' } };
      await expect(createMicroservice({ config: overrides })).rejects.toThrow(
        /Invalid configuration after merge/
      );
      // No runtime resource was constructed from the invalid config
      expect(mockCreateServiceIdentity).not.toHaveBeenCalled();
    });

    it('should expose a frozen configuration', async () => {
      const app = await createMicroservice({});
      expect(Object.isFrozen(app.config)).toBe(true);
    });

    it('should create service identity with service config', async () => {
      await createMicroservice({});
      expect(mockCreateServiceIdentity).toHaveBeenCalledWith(mockConfig.service);
    });

    it('should create registry with registry config', async () => {
      await createMicroservice({});
      expect(mockCreateRegistry).toHaveBeenCalledWith(mockConfig.registry);
    });

    it('should create authorization with auth config', async () => {
      await createMicroservice({});
      expect(mockCreateAuthorizationPolicy).toHaveBeenCalledWith('allowlist', {
        entries: mockConfig.auth.entries,
        defaultPolicy: mockConfig.auth.defaultPolicy,
        roles: mockConfig.auth.roles,
        serviceRoles: mockConfig.auth.serviceRoles,
        authenticationEnabled: mockConfig.security.authenticationEnabled,
      });
    });

    it('should create lifecycle manager with health check interval', async () => {
      await createMicroservice({});
      expect(MockedLifecycleManagerClass).toHaveBeenCalledWith(30000);
    });
  });

  describe('MicroserviceApp.start', () => {
    let app: MicroserviceApp;

    beforeEach(async () => {
      app = await createMicroservice({});
    });

    it('should register service in registry', async () => {
      await app.start();
      expect(mockRegistry.register).toHaveBeenCalledWith(mockIdentity.getRegistration());
    });

    it('should set lifecycle hooks with onStop that deregisters by lease ID', async () => {
      await app.start();
      expect(mockLifecycle.setHooks).toHaveBeenCalled();
      
      const hooks = mockLifecycle.setHooks.mock.calls[0][0];
      expect(hooks.onStop).toBeDefined();
      
      await hooks.onStop!();
      expect(mockRegistry.deregister).toHaveBeenCalledWith('lease-1');
    });

    it('should start lifecycle', async () => {
      await app.start();
      expect(mockLifecycle.start).toHaveBeenCalled();
    });

    it('should propagate start errors', async () => {
      mockLifecycle.start.mockRejectedValueOnce(new Error('start failed'));
      await expect(app.start()).rejects.toThrow('start failed');
    });
  });

  describe('MicroserviceApp.stop', () => {
    let app: MicroserviceApp;

    beforeEach(async () => {
      app = await createMicroservice({});
      await app.start();
    });

    it('should stop lifecycle', async () => {
      await app.stop();
      expect(mockLifecycle.stop).toHaveBeenCalled();
    });

    it('should propagate stop errors', async () => {
      mockLifecycle.stop.mockRejectedValueOnce(new Error('stop failed'));
      await expect(app.stop()).rejects.toThrow('stop failed');
    });
  });

  describe('MicroserviceApp.getTransport', () => {
    let app: MicroserviceApp;

    beforeEach(async () => {
      app = await createMicroservice({});
    });

    it('should delegate to lifecycle.getTransport', () => {
      mockLifecycle.getTransport.mockReturnValue(mockTransport);
      const transport = app.getTransport('test');
      expect(transport).toBe(mockTransport);
      expect(mockLifecycle.getTransport).toHaveBeenCalledWith('test');
    });

    it('should return undefined for non-existent transport', () => {
      mockLifecycle.getTransport.mockReturnValue(undefined);
      const transport = app.getTransport('non-existent');
      expect(transport).toBeUndefined();
    });
  });

  describe('MicroserviceApp.registerTransport', () => {
    let app: MicroserviceApp;

    beforeEach(async () => {
      app = await createMicroservice({});
    });

    it('should delegate to lifecycle.registerTransport', () => {
      app.registerTransport(mockTransport);
      expect(mockLifecycle.registerTransport).toHaveBeenCalledWith(mockTransport);
    });
  });

  describe('MicroserviceApp.unregisterTransport', () => {
    let app: MicroserviceApp;

    beforeEach(async () => {
      app = await createMicroservice({});
    });

    it('should delegate to lifecycle.unregisterTransport', () => {
      mockLifecycle.unregisterTransport.mockReturnValue(true);
      const result = app.unregisterTransport('test');
      expect(result).toBe(true);
      expect(mockLifecycle.unregisterTransport).toHaveBeenCalledWith('test');
    });

    it('should return false for non-existent transport', () => {
      mockLifecycle.unregisterTransport.mockReturnValue(false);
      const result = app.unregisterTransport('non-existent');
      expect(result).toBe(false);
    });
  });
});