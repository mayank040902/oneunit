import { ServiceIdentity } from './service-identity.js';

export interface AuthorizationPolicy {
  evaluate(context: AuthorizationContext): Promise<AuthorizationDecision>;
}

export interface AuthorizationContext {
  caller: ServiceIdentity;
  targetService?: string;
  operation: string;
  resource?: string;
  attributes: Record<string, unknown>;
}

export interface AuthorizationDecision {
  allowed: boolean;
  reason?: string;
  obligations?: string[];
}

export interface AllowlistEntry {
  serviceId: string;
  allowedOperations: string[];
  allowedResources?: string[];
  allowedTargets?: string[];
}

export class AllowlistPolicy implements AuthorizationPolicy {
  private allowlist: Map<string, AllowlistEntry> = new Map();
  private defaultPolicy: 'allow' | 'deny' = 'deny';

  constructor(entries: AllowlistEntry[] = [], defaultPolicy: 'allow' | 'deny' = 'deny') {
    for (const entry of entries) {
      this.allowlist.set(entry.serviceId, entry);
    }
    this.defaultPolicy = defaultPolicy;
  }

  async evaluate(context: AuthorizationContext): Promise<AuthorizationDecision> {
    const entry = this.allowlist.get(context.caller.serviceId);
    
    if (!entry) {
      return {
        allowed: this.defaultPolicy === 'allow',
        reason: this.defaultPolicy === 'allow' ? 'Default allow policy' : 'Service not in allowlist',
      };
    }

    if (!entry.allowedOperations.includes(context.operation) && !entry.allowedOperations.includes('*')) {
      return {
        allowed: false,
        reason: `Operation ${context.operation} not allowed for service ${context.caller.serviceId}`,
      };
    }

    if (context.targetService && entry.allowedTargets && !entry.allowedTargets.includes(context.targetService)) {
      return {
        allowed: false,
        reason: `Target service ${context.targetService} not allowed for service ${context.caller.serviceId}`,
      };
    }

    if (context.resource && entry.allowedResources && !entry.allowedResources.includes(context.resource)) {
      return {
        allowed: false,
        reason: `Resource ${context.resource} not allowed for service ${context.caller.serviceId}`,
      };
    }

    return { allowed: true };
  }

  addEntry(entry: AllowlistEntry): void {
    this.allowlist.set(entry.serviceId, entry);
  }

  removeEntry(serviceId: string): void {
    this.allowlist.delete(serviceId);
  }

  setDefaultPolicy(policy: 'allow' | 'deny'): void {
    this.defaultPolicy = policy;
  }
}

export class RbacPolicy implements AuthorizationPolicy {
  private roles: Map<string, Set<string>> = new Map();
  private permissions: Map<string, Set<string>> = new Map();
  private serviceRoles: Map<string, Set<string>> = new Map();

  addRole(role: string, permissions: string[]): void {
    this.roles.set(role, new Set(permissions));
  }

  addPermission(permission: string, operations: string[]): void {
    this.permissions.set(permission, new Set(operations));
  }

  assignRole(serviceId: string, role: string): void {
    if (!this.serviceRoles.has(serviceId)) {
      this.serviceRoles.set(serviceId, new Set());
    }
    this.serviceRoles.get(serviceId)!.add(role);
  }

  removeRole(serviceId: string, role: string): void {
    this.serviceRoles.get(serviceId)?.delete(role);
  }

  async evaluate(context: AuthorizationContext): Promise<AuthorizationDecision> {
    const roles = this.serviceRoles.get(context.caller.serviceId);
    if (!roles || roles.size === 0) {
      return { allowed: false, reason: 'No roles assigned to service' };
    }

    for (const role of roles) {
      const rolePermissions = this.roles.get(role);
      if (!rolePermissions) continue;

      for (const permission of rolePermissions) {
        const operations = this.permissions.get(permission);
        if (operations && operations.has(context.operation)) {
          return { allowed: true };
        }
      }
    }

    return { allowed: false, reason: 'No matching role permission for operation' };
  }
}

export class CompositePolicy implements AuthorizationPolicy {
  private policies: AuthorizationPolicy[] = [];

  addPolicy(policy: AuthorizationPolicy): void {
    this.policies.push(policy);
  }

  async evaluate(context: AuthorizationContext): Promise<AuthorizationDecision> {
    for (const policy of this.policies) {
      const decision = await policy.evaluate(context);
      if (!decision.allowed) {
        return decision;
      }
    }
    return { allowed: true };
  }
}

export function createAuthorizationPolicy(
  type: 'allowlist' | 'rbac' | 'composite',
  options: {
    entries?: AllowlistEntry[];
    defaultPolicy?: 'allow' | 'deny';
    roles?: Record<string, string[]>;
    permissions?: Record<string, string[]>;
    serviceRoles?: Record<string, string[]>;
  } = {}
): AuthorizationPolicy {
  switch (type) {
    case 'allowlist':
      return new AllowlistPolicy(options.entries ?? [], options.defaultPolicy ?? 'deny');
    
    case 'rbac': {
      const policy = new RbacPolicy();
      if (options.roles) {
        for (const [role, perms] of Object.entries(options.roles)) {
          policy.addRole(role, perms);
        }
      }
      if (options.serviceRoles) {
        for (const [serviceId, roles] of Object.entries(options.serviceRoles)) {
          for (const role of roles) {
            policy.assignRole(serviceId, role);
          }
        }
      }
      return policy;
    }
    
    case 'composite': {
      const policy = new CompositePolicy();
      if (options.entries) {
        policy.addPolicy(new AllowlistPolicy(options.entries, options.defaultPolicy ?? 'deny'));
      }
      if (options.roles) {
        const rbac = new RbacPolicy();
        for (const [role, perms] of Object.entries(options.roles)) {
          rbac.addRole(role, perms);
        }
        if (options.serviceRoles) {
          for (const [serviceId, roles] of Object.entries(options.serviceRoles)) {
            for (const role of roles) {
              rbac.assignRole(serviceId, role);
            }
          }
        }
        policy.addPolicy(rbac);
      }
      return policy;
    }
    
    default:
      throw new Error(`Unknown authorization policy type: ${type}`);
  }
}