import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Transport } from '../../src/core/capabilities.js';
import { ServiceRegistry } from '../../src/registry/registry.js';
import { ServiceIdentity } from '../../src/identity/service-identity.js';
import { AuthorizationPolicy } from '../../src/identity/authorization.js';
import { LifecycleManager } from '../../src/core/lifecycle.js';

// Mock all dependencies at the top level
vi.mock('../../src/config/loader.js', () => ({
  loadConfig: vi.fn(),
}));
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

  beforeEach(() => {
    vi.clearAllMocks();
    
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
      security: {},
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
      register: vi.fn().mockResolvedValue({ leaseId: 'lease-1' }),
      deregister: vi.fn().mockResolvedValue(undefined),
    };

    mockIdentity = {
      serviceId: '123e4567-e89b-12d3-a456-426614174000',
      getRegistration: vi.fn().mockReturnValue({ serviceId: 'test' }),
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

  describe('createMicroservice', () => {
    it('should create app with all required properties', async () => {
      const app = await createMicroservice({});

      expect(app).toBeDefined();
      expect(app.service).toBe(mockConfig.service);
      expect(app.config).toBe(mockConfig);
      expect(app.registry).toBe(mockRegistry);
      expect(app.identity).toBe(mockIdentity);
      expect(app.authorization).toBe(mockAuthorization);
      expect(app.lifecycle).toBe(mockLifecycle);
    });

    it('should load config from file when configPath provided', async () => {
      await createMicroservice({ configPath: '/custom/path.json' });
      expect(mockLoadConfig).toHaveBeenCalledWith('/custom/path.json');
    });

    it('should merge provided config overrides', async () => {
      const overrides = { service: { name: 'overridden-service' } };
      await createMicroservice({ config: overrides });
      
      // Object.assign merges at top level
      expect(mockConfig.service.name).toBe('overridden-service');
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

    it('should set lifecycle hooks with onStop that deregisters', async () => {
      await app.start();
      expect(mockLifecycle.setHooks).toHaveBeenCalled();
      
      const hooks = mockLifecycle.setHooks.mock.calls[0][0];
      expect(hooks.onStop).toBeDefined();
      
      await hooks.onStop!();
      expect(mockRegistry.deregister).toHaveBeenCalledWith(mockIdentity.serviceId);
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