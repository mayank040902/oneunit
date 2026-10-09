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

// === NEW ADVERSARIAL TESTS ===

describe('AllowlistPolicy - Security and Edge Cases', () => {
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

  it('should deny by default (fail-closed)', async () => {
    const defaultDenyPolicy = new AllowlistPolicy([], 'deny');
    const context = createContext({ caller: createMockIdentity('unknown-service') });
    const decision = await defaultDenyPolicy.evaluate(context);
    
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('Service not in allowlist');
  });

  it('should handle wildcard operations correctly', async () => {
    const wildcardPolicy = new AllowlistPolicy([
      { serviceId: 'wildcard-svc', allowedOperations: ['*'] },
    ], 'deny');
    
    const context = createContext({ 
      caller: createMockIdentity('wildcard-svc'), 
      operation: 'any-operation' 
    });
    const decision = await wildcardPolicy.evaluate(context);
    
    expect(decision.allowed).toBe(true);
  });

  it('should check resources when provided and allowedResources is defined', async () => {
    const policy = new AllowlistPolicy([
      { serviceId: 'wildcard-svc', allowedOperations: ['read'], allowedResources: ['resource-1'] },
    ], 'deny');
    
    // Should allow when resource matches
    let context = createContext({ 
      caller: createMockIdentity('wildcard-svc'), 
      operation: 'read',
      resource: 'resource-1' 
    });
    let decision = await policy.evaluate(context);
    expect(decision.allowed).toBe(true);
    
    // Should deny when resource doesn't match
    context = createContext({ 
      caller: createMockIdentity('wildcard-svc'), 
      operation: 'read',
      resource: 'resource-2' 
    });
    decision = await policy.evaluate(context);
    expect(decision.allowed).toBe(false);
    
    // Should allow when no resource specified (no resource check)
    context = createContext({ 
      caller: createMockIdentity('wildcard-svc'), 
      operation: 'read'
    });
    decision = await policy.evaluate(context);
    expect(decision.allowed).toBe(true);
  });

  it('should check targets when provided and allowedTargets is defined', async () => {
    const policy = new AllowlistPolicy([
      { serviceId: 'wildcard-svc', allowedOperations: ['read'], allowedTargets: ['target-1'] },
    ], 'deny');
    
    // Should allow when target matches
    let context = createContext({ 
      caller: createMockIdentity('wildcard-svc'), 
      operation: 'read',
      targetService: 'target-1' 
    });
    let decision = await policy.evaluate(context);
    expect(decision.allowed).toBe(true);
    
    // Should deny when target doesn't match
    context = createContext({ 
      caller: createMockIdentity('wildcard-svc'), 
      operation: 'read',
      targetService: 'target-2' 
    });
    decision = await policy.evaluate(context);
    expect(decision.allowed).toBe(false);
    
    // Should allow when no target specified (no target check)
    context = createContext({ 
      caller: createMockIdentity('wildcard-svc'), 
      operation: 'read'
    });
    decision = await policy.evaluate(context);
    expect(decision.allowed).toBe(true);
  });

  it('should handle empty allowed lists as deny-all', async () => {
    const emptyPolicy = new AllowlistPolicy([
      { serviceId: 'empty-svc', allowedOperations: [] },
    ], 'deny');
    
    const context = createContext({ 
      caller: createMockIdentity('empty-svc'), 
      operation: 'read' 
    });
    const decision = await emptyPolicy.evaluate(context);
    
    expect(decision.allowed).toBe(false);
  });

  it('should handle concurrent evaluations', async () => {
    const contexts = Array.from({ length: 50 }, (_, i) => 
      createContext({ 
        caller: createMockIdentity(i % 2 === 0 ? 'service-1' : 'service-2'),
        operation: i % 3 === 0 ? 'read' : 'write',
      })
    );
    
    const results = await Promise.all(contexts.map(ctx => policy.evaluate(ctx)));
    
    results.forEach((decision, i) => {
      const serviceId = i % 2 === 0 ? 'service-1' : 'service-2';
      const operation = i % 3 === 0 ? 'read' : 'write';
      
      if (serviceId === 'service-1' && (operation === 'read' || operation === 'write')) {
        expect(decision.allowed).toBe(true);
      } else if (serviceId === 'service-2') {
        expect(decision.allowed).toBe(true); // service-2 has wildcard operations
      } else {
        expect(decision.allowed).toBe(false);
      }
    });
  });

  it('should not allow operation not in list even with wildcard resource/target', async () => {
    const context = createContext({ 
      caller: createMockIdentity('service-1'), 
      operation: 'delete', // Not in allowedOperations
      resource: 'resource-1',
      targetService: 'target-service',
    });
    const decision = await policy.evaluate(context);
    
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('delete not allowed');
  });

  it('should handle special characters in service IDs', async () => {
    policy.addEntry({
      serviceId: 'service/with:special\\chars',
      allowedOperations: ['read'],
    });
    
    const context = createContext({ 
      caller: createMockIdentity('service/with:special\\chars'), 
      operation: 'read' 
    });
    const decision = await policy.evaluate(context);
    
    expect(decision.allowed).toBe(true);
  });

  it('should handle very long service IDs', async () => {
    const longId = 'service-' + 'x'.repeat(1000);
    policy.addEntry({
      serviceId: longId,
      allowedOperations: ['read'],
    });
    
    const context = createContext({ 
      caller: createMockIdentity(longId), 
      operation: 'read' 
    });
    const decision = await policy.evaluate(context);
    
    expect(decision.allowed).toBe(true);
  });

  it('should handle dynamic policy changes', async () => {
    // Initially deny
    let context = createContext({ caller: createMockIdentity('service-3'), operation: 'read' });
    let decision = await policy.evaluate(context);
    expect(decision.allowed).toBe(false);
    
    // Add entry
    policy.addEntry({ serviceId: 'service-3', allowedOperations: ['read'] });
    decision = await policy.evaluate(context);
    expect(decision.allowed).toBe(true);
    
    // Remove entry
    policy.removeEntry('service-3');
    decision = await policy.evaluate(context);
    expect(decision.allowed).toBe(false);
  });

  it('should handle default policy change', async () => {
    let context = createContext({ caller: createMockIdentity('service-3'), operation: 'read' });
    let decision = await policy.evaluate(context);
    expect(decision.allowed).toBe(false);
    
    policy.setDefaultPolicy('allow');
    decision = await policy.evaluate(context);
    expect(decision.allowed).toBe(true);
  });
});

describe('RbacPolicy - Security and Edge Cases', () => {
  let policy: RbacPolicy;

  beforeEach(() => {
    policy = new RbacPolicy();
  });

  it('should deny when no roles assigned (fail-closed)', async () => {
    const context = createContext();
    const decision = await policy.evaluate(context);
    
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('No roles assigned to service');
  });

  it('should deny when role has no permissions', async () => {
    policy.addRole('empty-role', []);
    policy.assignRole('service-1', 'empty-role');
    
    const context = createContext({ operation: 'read' });
    const decision = await policy.evaluate(context);
    
    expect(decision.allowed).toBe(false);
  });

  it('should deny when permission has no operations', async () => {
    policy.addRole('role-1', ['perm-1']);
    policy.addPermission('perm-1', []);
    policy.assignRole('service-1', 'role-1');
    
    const context = createContext({ operation: 'read' });
    const decision = await policy.evaluate(context);
    
    expect(decision.allowed).toBe(false);
  });

  it('should allow when role has matching permission with operation', async () => {
    policy.addRole('admin', ['perm-1']);
    policy.addPermission('perm-1', ['read', 'write']);
    policy.assignRole('service-1', 'admin');
    
    const context = createContext({ operation: 'read' });
    const decision = await policy.evaluate(context);
    
    expect(decision.allowed).toBe(true);
  });

  it('should handle multiple roles with different permissions', async () => {
    policy.addRole('admin', ['perm-1', 'perm-2']);
    policy.addRole('user', ['perm-3']);
    policy.addPermission('perm-1', ['read']);
    policy.addPermission('perm-2', ['write']);
    policy.addPermission('perm-3', ['read']);
    policy.assignRole('service-1', 'admin');
    policy.assignRole('service-1', 'user');
    
    let context = createContext({ operation: 'read' });
    let decision = await policy.evaluate(context);
    expect(decision.allowed).toBe(true);
    
    context = createContext({ operation: 'write' });
    decision = await policy.evaluate(context);
    expect(decision.allowed).toBe(true);
  });

  it('should handle role removal', async () => {
    policy.addRole('admin', ['perm-1']);
    policy.addPermission('perm-1', ['read']);
    policy.assignRole('service-1', 'admin');
    
    let context = createContext({ operation: 'read' });
    let decision = await policy.evaluate(context);
    expect(decision.allowed).toBe(true);
    
    policy.removeRole('service-1', 'admin');
    decision = await policy.evaluate(context);
    expect(decision.allowed).toBe(false);
  });

  it('should handle concurrent evaluations', async () => {
    policy.addRole('admin', ['perm-1']);
    policy.addPermission('perm-1', ['read', 'write']);
    policy.assignRole('service-1', 'admin');
    policy.assignRole('service-2', 'admin');
    
    const contexts = Array.from({ length: 50 }, (_, i) => 
      createContext({ 
        caller: createMockIdentity(i % 2 === 0 ? 'service-1' : 'service-2'),
        operation: i % 2 === 0 ? 'read' : 'write',
      })
    );
    
    const results = await Promise.all(contexts.map(ctx => policy.evaluate(ctx)));
    results.forEach(decision => expect(decision.allowed).toBe(true));
  });

  it('should handle special characters in role names', async () => {
    policy.addRole('role/with:special\\chars', ['perm-1']);
    policy.addPermission('perm-1', ['read']);
    policy.assignRole('service-1', 'role/with:special\\chars');
    
    const context = createContext({ operation: 'read' });
    const decision = await policy.evaluate(context);
    
    expect(decision.allowed).toBe(true);
  });

  it('should handle very long role/permission names', async () => {
    const longRole = 'role-' + 'x'.repeat(1000);
    const longPerm = 'perm-' + 'y'.repeat(1000);
    
    policy.addRole(longRole, [longPerm]);
    policy.addPermission(longPerm, ['read']);
    policy.assignRole('service-1', longRole);
    
    const context = createContext({ operation: 'read' });
    const decision = await policy.evaluate(context);
    
    expect(decision.allowed).toBe(true);
  });
});

describe('CompositePolicy - Security and Edge Cases', () => {
  it('should deny when any policy denies (short-circuit)', async () => {
    const policy = new CompositePolicy();
    const denyAll = new AllowlistPolicy([], 'deny');
    const allowAll = new AllowlistPolicy([], 'allow');
    
    policy.addPolicy(denyAll);
    policy.addPolicy(allowAll);
    
    const context = createContext();
    const decision = await policy.evaluate(context);
    
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('Service not in allowlist');
  });

  it('should evaluate policies in order - AND composition requires all policies to allow', async () => {
    const policy = new CompositePolicy();
    // First policy allows everything (default allow)
    const allowFirst = new AllowlistPolicy([], 'allow');
    // Second policy denies everything (default deny) but service not in list
    const denySecond = new AllowlistPolicy([], 'deny');
    
    policy.addPolicy(allowFirst);
    policy.addPolicy(denySecond);
    
    const context = createContext();
    const decision = await policy.evaluate(context);
    
    // CompositePolicy is AND composition - ALL policies must allow
    // Second policy denies, so composite denies
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('Service not in allowlist');
  });

  it('should handle empty composite policy', async () => {
    const policy = new CompositePolicy();
    const context = createContext();
    const decision = await policy.evaluate(context);
    
    // Empty composite policy allows by default (no policies to deny)
    expect(decision.allowed).toBe(true);
  });

  it('should handle many policies in composite', async () => {
    const policy = new CompositePolicy();
    
    for (let i = 0; i < 10; i++) {
      // Each policy allows its own service
      policy.addPolicy(new AllowlistPolicy([
        { serviceId: `service-${i}`, allowedOperations: ['read'] },
      ], 'deny'));
    }
    
    // This service is in the 6th policy (service-5)
    const context = createContext({ caller: createMockIdentity('service-5'), operation: 'read' });
    const decision = await policy.evaluate(context);
    
    // The first 5 policies don't have service-5, so they deny. 
    // But wait - the first policy denies and stops. We need to add a policy that allows first.
    // Actually, this test is testing the wrong behavior. Let me fix the test to be realistic.
    expect(decision.allowed).toBe(false); // First policy (service-0) doesn't have service-5, denies
  });

  it('should handle concurrent evaluations', async () => {
    const policy = new CompositePolicy();
    const allowlist = new AllowlistPolicy([
      { serviceId: 'service-1', allowedOperations: ['read'] },
    ], 'deny');
    const rbac = new RbacPolicy();
    rbac.addRole('admin', ['perm-1']);
    rbac.addPermission('perm-1', ['read']);
    rbac.assignRole('service-1', 'admin');
    
    policy.addPolicy(allowlist);
    policy.addPolicy(rbac);
    
    const contexts = Array.from({ length: 50 }, () => createContext());
    const results = await Promise.all(contexts.map(ctx => policy.evaluate(ctx)));
    
    results.forEach(decision => expect(decision.allowed).toBe(true));
  });
});

describe('createAuthorizationPolicy - Edge Cases', () => {
  it('should throw for unknown policy type', () => {
    expect(() => createAuthorizationPolicy('unknown' as any)).toThrow('Unknown authorization policy type: unknown');
  });

  it('should create allowlist policy with default deny', () => {
    const policy = createAuthorizationPolicy('allowlist', {
      entries: [{ serviceId: 'svc-1', allowedOperations: ['read'] }],
    });
    expect(policy).toBeInstanceOf(AllowlistPolicy);
  });

  it('should create allowlist policy with default allow', () => {
    const policy = createAuthorizationPolicy('allowlist', {
      entries: [],
      defaultPolicy: 'allow',
    });
    expect(policy).toBeInstanceOf(AllowlistPolicy);
  });

  it('should create rbac policy with full config', () => {
    const policy = createAuthorizationPolicy('rbac', {
      roles: { admin: ['perm-1'], user: ['perm-2'] },
      permissions: { 'perm-1': ['read', 'write'], 'perm-2': ['read'] },
      serviceRoles: { 'svc-1': ['admin'], 'svc-2': ['user'] },
    });
    expect(policy).toBeInstanceOf(RbacPolicy);
  });

  it('should create composite with allowlist only', () => {
    const policy = createAuthorizationPolicy('composite', {
      entries: [{ serviceId: 'svc-1', allowedOperations: ['read'] }],
      defaultPolicy: 'deny',
    });
    expect(policy).toBeInstanceOf(CompositePolicy);
  });

  it('should create composite with rbac only', () => {
    const policy = createAuthorizationPolicy('composite', {
      roles: { admin: ['perm-1'] },
      serviceRoles: { 'svc-1': ['admin'] },
    });
    expect(policy).toBeInstanceOf(CompositePolicy);
  });

  it('should create composite with both', () => {
    const policy = createAuthorizationPolicy('composite', {
      entries: [{ serviceId: 'svc-1', allowedOperations: ['read'] }],
      roles: { admin: ['perm-1'] },
      permissions: { 'perm-1': ['read'] },
      serviceRoles: { 'svc-1': ['admin'] },
    });
    expect(policy).toBeInstanceOf(CompositePolicy);
  });
});