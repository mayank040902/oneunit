import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AuthorizationPolicy,
  AuthorizationContext,
  AuthorizationDecision,
  AllowlistEntry,
  AllowlistPolicy,
  RbacPolicy,
  CompositePolicy,
  createAuthorizationPolicy,
} from '../../src/identity/authorization.js';
import { ServiceIdentity } from '../../src/identity/service-identity.js';

function createMockIdentity(serviceId: string): ServiceIdentity {
  return {
    serviceId,
    serviceName: 'test-service',
    instanceId: 'inst-1',
    credentials: {
      type: 'api-key',
      apiKey: 'key',
      issuedAt: Date.now(),
    },
    getRegistration: () => ({} as any),
    sign: async () => new Uint8Array(),
    verify: async () => false,
  };
}

function createContext(overrides: Partial<AuthorizationContext> = {}): AuthorizationContext {
  return {
    caller: createMockIdentity('service-1'),
    operation: 'read',
    resource: 'resource-1',
    targetService: 'target-service',
    attributes: {},
    ...overrides,
  };
}

describe('AllowlistPolicy', () => {
  let policy: AllowlistPolicy;
  const entries: AllowlistEntry[] = [
    {
      serviceId: 'service-1',
      allowedOperations: ['read', 'write'],
      allowedResources: ['resource-1', 'resource-2'],
      allowedTargets: ['target-service'],
    },
    {
      serviceId: 'service-2',
      allowedOperations: ['*'],
      allowedResources: ['*'],
      allowedTargets: ['*'],
    },
  ];

  beforeEach(() => {
    policy = new AllowlistPolicy(entries, 'deny');
  });

  it('should allow service in allowlist with matching operation', async () => {
    const context = createContext({ caller: createMockIdentity('service-1'), operation: 'read' });
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeUndefined();
  });

  it('should allow service with wildcard operation', async () => {
    const context = createContext({ 
      caller: createMockIdentity('service-2'), 
      operation: 'delete',
      targetService: undefined,
      resource: undefined,
    });
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(true);
  });

  it('should deny service not in allowlist with default deny', async () => {
    const context = createContext({ caller: createMockIdentity('service-3') });
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('Service not in allowlist');
  });

  it('should allow service not in allowlist with default allow', async () => {
    const allowPolicy = new AllowlistPolicy([], 'allow');
    const context = createContext({ caller: createMockIdentity('service-3') });
    const decision = await allowPolicy.evaluate(context);

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('Default allow policy');
  });

  it('should deny operation not in allowed list', async () => {
    const context = createContext({ caller: createMockIdentity('service-1'), operation: 'delete' });
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('Operation delete not allowed for service service-1');
  });

  it('should deny target service not in allowed targets', async () => {
    const context = createContext({
      caller: createMockIdentity('service-1'),
      targetService: 'other-service',
    });
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('Target service other-service not allowed for service service-1');
  });

  it('should deny resource not in allowed resources', async () => {
    const context = createContext({
      caller: createMockIdentity('service-1'),
      resource: 'resource-3',
    });
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('Resource resource-3 not allowed for service service-1');
  });

  it('should allow when target service matches', async () => {
    const context = createContext({
      caller: createMockIdentity('service-1'),
      targetService: 'target-service',
    });
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(true);
  });

  it('should allow when resource matches', async () => {
    const context = createContext({
      caller: createMockIdentity('service-1'),
      resource: 'resource-1',
    });
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(true);
  });

  it('should allow when no target service specified', async () => {
    const context = createContext({
      caller: createMockIdentity('service-1'),
      targetService: undefined,
    });
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(true);
  });

  it('should allow when no resource specified', async () => {
    const context = createContext({
      caller: createMockIdentity('service-1'),
      resource: undefined,
    });
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(true);
  });

  it('should add entry dynamically', async () => {
    policy.addEntry({
      serviceId: 'service-3',
      allowedOperations: ['read'],
    });

    const context = createContext({ caller: createMockIdentity('service-3'), operation: 'read' });
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(true);
  });

  it('should remove entry dynamically', async () => {
    policy.removeEntry('service-1');

    const context = createContext({ caller: createMockIdentity('service-1') });
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(false);
  });

  it('should change default policy dynamically', async () => {
    policy.setDefaultPolicy('allow');

    const context = createContext({ caller: createMockIdentity('service-3') });
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(true);
  });
});

describe('RbacPolicy', () => {
  let policy: RbacPolicy;

  beforeEach(() => {
    policy = new RbacPolicy();
  });

  it('should deny when no roles assigned', async () => {
    const context = createContext();
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('No roles assigned to service');
  });

  it('should allow when role has matching permission', async () => {
    policy.addRole('admin', ['permission-1']);
    policy.addPermission('permission-1', ['read', 'write']);
    policy.assignRole('service-1', 'admin');

    const context = createContext({ operation: 'read' });
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(true);
  });

  it('should deny when role has no matching permission', async () => {
    policy.addRole('admin', ['permission-1']);
    policy.addPermission('permission-1', ['write']);
    policy.assignRole('service-1', 'admin');

    const context = createContext({ operation: 'read' });
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('No matching role permission for operation');
  });

  it('should allow when any role matches', async () => {
    policy.addRole('admin', ['permission-1']);
    policy.addRole('user', ['permission-2']);
    policy.addPermission('permission-1', ['read']);
    policy.addPermission('permission-2', ['write']);
    policy.assignRole('service-1', 'admin');
    policy.assignRole('service-1', 'user');

    const context = createContext({ operation: 'write' });
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(true);
  });

  it('should deny when permission not defined', async () => {
    policy.addRole('admin', ['permission-1']);
    // permission-1 not added
    policy.assignRole('service-1', 'admin');

    const context = createContext({ operation: 'read' });
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(false);
  });

  it('should add and remove roles', async () => {
    policy.addRole('admin', ['permission-1']);
    policy.addPermission('permission-1', ['read']);
    policy.assignRole('service-1', 'admin');

    let context = createContext({ operation: 'read' });
    let decision = await policy.evaluate(context);
    expect(decision.allowed).toBe(true);

    policy.removeRole('service-1', 'admin');

    decision = await policy.evaluate(context);
    expect(decision.allowed).toBe(false);
  });

  it('should handle multiple services with different roles', async () => {
    policy.addRole('admin', ['permission-1']);
    policy.addPermission('permission-1', ['read']);
    policy.assignRole('service-1', 'admin');
    policy.assignRole('service-2', 'user');

    const context1 = createContext({ caller: createMockIdentity('service-1'), operation: 'read' });
    const context2 = createContext({ caller: createMockIdentity('service-2'), operation: 'read' });

    const decision1 = await policy.evaluate(context1);
    const decision2 = await policy.evaluate(context2);

    expect(decision1.allowed).toBe(true);
    expect(decision2.allowed).toBe(false);
  });
});

describe('CompositePolicy', () => {
  it('should allow when all policies allow', async () => {
    const policy = new CompositePolicy();
    const allowlist = new AllowlistPolicy([
      { serviceId: 'service-1', allowedOperations: ['read'] },
    ], 'deny');
    const rbac = new RbacPolicy();
    rbac.addRole('admin', ['permission-1']);
    rbac.addPermission('permission-1', ['read']);
    rbac.assignRole('service-1', 'admin');

    policy.addPolicy(allowlist);
    policy.addPolicy(rbac);

    const context = createContext();
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(true);
  });

  it('should deny when first policy denies', async () => {
    const policy = new CompositePolicy();
    const allowlist = new AllowlistPolicy([], 'deny'); // deny all
    const rbac = new RbacPolicy();
    rbac.addRole('admin', ['permission-1']);
    rbac.addPermission('permission-1', ['read']);
    rbac.assignRole('service-1', 'admin');

    policy.addPolicy(allowlist);
    policy.addPolicy(rbac);

    const context = createContext();
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('Service not in allowlist');
  });

  it('should deny when second policy denies', async () => {
    const policy = new CompositePolicy();
    const allowlist = new AllowlistPolicy([
      { serviceId: 'service-1', allowedOperations: ['read'] },
    ], 'deny');
    const rbac = new RbacPolicy(); // no roles assigned

    policy.addPolicy(allowlist);
    policy.addPolicy(rbac);

    const context = createContext();
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('No roles assigned to service');
  });

  it('should evaluate policies in order', async () => {
    const policy = new CompositePolicy();
    const denyAll = new AllowlistPolicy([], 'deny');
    const allowAll = new AllowlistPolicy([], 'allow');

    policy.addPolicy(denyAll);
    policy.addPolicy(allowAll);

    const context = createContext();
    const decision = await policy.evaluate(context);

    expect(decision.allowed).toBe(false); // First policy denies
  });
});

describe('createAuthorizationPolicy', () => {
  it('should create allowlist policy', () => {
    const policy = createAuthorizationPolicy('allowlist', {
      entries: [{ serviceId: 'svc-1', allowedOperations: ['read'] }],
      defaultPolicy: 'deny',
    });

    expect(policy).toBeInstanceOf(AllowlistPolicy);
  });

  it('should create rbac policy', () => {
    const policy = createAuthorizationPolicy('rbac', {
      roles: { admin: ['perm-1'] },
      permissions: { 'perm-1': ['read'] },
      serviceRoles: { 'svc-1': ['admin'] },
    });

    expect(policy).toBeInstanceOf(RbacPolicy);
  });

  it('should create composite policy with allowlist', () => {
    const policy = createAuthorizationPolicy('composite', {
      entries: [{ serviceId: 'svc-1', allowedOperations: ['read'] }],
      defaultPolicy: 'deny',
    });

    expect(policy).toBeInstanceOf(CompositePolicy);
  });

  it('should create composite policy with rbac', () => {
    const policy = createAuthorizationPolicy('composite', {
      roles: { admin: ['perm-1'] },
      serviceRoles: { 'svc-1': ['admin'] },
    });

    expect(policy).toBeInstanceOf(CompositePolicy);
  });

  it('should create composite policy with both', () => {
    const policy = createAuthorizationPolicy('composite', {
      entries: [{ serviceId: 'svc-1', allowedOperations: ['read'] }],
      roles: { admin: ['perm-1'] },
      permissions: { 'perm-1': ['read'] },
      serviceRoles: { 'svc-1': ['admin'] },
    });

    expect(policy).toBeInstanceOf(CompositePolicy);
  });

  it('should throw for unknown policy type', () => {
    expect(() => createAuthorizationPolicy('unknown' as any)).toThrow(
      'Unknown authorization policy type: unknown'
    );
  });
});

describe('Authorization types', () => {
  it('should define AllowlistEntry structure', () => {
    const entry: AllowlistEntry = {
      serviceId: 'svc-1',
      allowedOperations: ['read', 'write'],
      allowedResources: ['res-1'],
      allowedTargets: ['target-1'],
    };
    expect(entry.serviceId).toBe('svc-1');
    expect(entry.allowedOperations).toContain('read');
  });

  it('should define AuthorizationContext structure', () => {
    const context: AuthorizationContext = {
      caller: createMockIdentity('svc-1'),
      targetService: 'target-1',
      operation: 'read',
      resource: 'res-1',
      attributes: { key: 'value' },
    };
    expect(context.operation).toBe('read');
    expect(context.attributes.key).toBe('value');
  });

  it('should define AuthorizationDecision structure', () => {
    const decision: AuthorizationDecision = {
      allowed: true,
      reason: 'allowed',
      obligations: ['log', 'audit'],
    };
    expect(decision.allowed).toBe(true);
    expect(decision.obligations).toContain('log');
  });
});