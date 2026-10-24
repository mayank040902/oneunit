import { ForbiddenError, ValidationError } from "../errors/index.js";
import type { AuthSubject, RBACOptions, RoleDefinition, StoredRole } from "../types/index.js";
import { isPlainObject, toArray, unique } from "../utils.js";

function normalizeName(value: unknown): string {
  return String(value).trim();
}

function asSet(values: unknown): Set<string> {
  return new Set(
    unique(toArray(values).map((item) => normalizeName(item)).filter(Boolean)),
  );
}

export class RBAC {
  roles = new Map<string, StoredRole>();
  permissions = new Set<string>();
  rolePermissions = new Map<string, Set<string>>();
  roleParents = new Map<string, string[]>();
  defaultRole: string | null;

  constructor(options: RBACOptions = {}) {
    this.defaultRole = options.defaultRole ?? null;

    if (Array.isArray(options.permissions)) {
      for (const permission of options.permissions) {
        this.addPermission(permission);
      }
    }

    if (isPlainObject(options.roles)) {
      for (const [role, config] of Object.entries(options.roles)) {
        this.addRole(role, config);
      }
    } else if (Array.isArray(options.roles)) {
      for (const role of options.roles) {
        this.addRole(role);
      }
    }
  }

  addPermission(permission: string): this {
    const name = normalizeName(permission);
    if (!name) {
      throw new ValidationError("Permission name is required");
    }
    this.permissions.add(name);
    return this;
  }

  addRole(role: string | RoleDefinition, config: RoleDefinition = {}): this {
    const name = normalizeName(typeof role === "string" ? role : role?.name);
    if (!name) {
      throw new ValidationError("Role name is required");
    }

    const definition = isPlainObject(config) ? config : {};
    const permissions = asSet(definition.permissions ?? definition.perms);
    const inherits = unique(
      toArray(definition.inherits ?? definition.parents ?? definition.parent).map(normalizeName).filter(Boolean),
    );

    for (const permission of permissions) {
      this.permissions.add(permission);
    }

    this.roles.set(name, {
      name,
      description: typeof definition.description === "string" ? definition.description : "",
    });
    this.rolePermissions.set(name, new Set([
      ...(this.rolePermissions.get(name) ?? []),
      ...permissions,
    ]));
    this.roleParents.set(name, unique([
      ...(this.roleParents.get(name) ?? []),
      ...inherits,
    ]));

    return this;
  }

  grant(role: string, permissions: string | string[]): this {
    const name = this.requireRole(role);
    const granted = asSet(permissions);
    const current = this.rolePermissions.get(name) ?? new Set<string>();
    for (const permission of granted) {
      this.permissions.add(permission);
      current.add(permission);
    }
    this.rolePermissions.set(name, current);
    return this;
  }

  revoke(role: string, permissions: string | string[]): this {
    const name = this.requireRole(role);
    const current = this.rolePermissions.get(name) ?? new Set<string>();
    for (const permission of asSet(permissions)) {
      current.delete(permission);
    }
    this.rolePermissions.set(name, current);
    return this;
  }

  inherit(role: string, parents: string | string[]): this {
    const name = this.requireRole(role);
    const next = unique([
      ...(this.roleParents.get(name) ?? []),
      ...toArray(parents).map(normalizeName).filter(Boolean),
    ]);
    this.roleParents.set(name, next);
    return this;
  }

  hasRole(role: string): boolean {
    return this.roles.has(normalizeName(role));
  }

  requireRole(role: string): string {
    const name = normalizeName(role);
    if (!this.roles.has(name)) {
      throw new ValidationError(`Unknown role: ${role}`);
    }
    return name;
  }

  getRoles(): string[] {
    return [...this.roles.keys()];
  }

  getPermissions(role?: string): string[] {
    if (role === undefined) {
      return [...this.permissions];
    }
    return [...this.resolvePermissions(role)];
  }

  resolveParents(role: string, seen = new Set<string>()): string[] {
    const name = normalizeName(role);
    if (!this.roles.has(name) || seen.has(name)) {
      return [];
    }

    seen.add(name);
    const parents: string[] = [];
    for (const parent of this.roleParents.get(name) ?? []) {
      parents.push(parent, ...this.resolveParents(parent, seen));
    }
    return unique(parents);
  }

  resolvePermissions(role: string): Set<string> {
    const name = normalizeName(role);
    const resolved = new Set(this.rolePermissions.get(name) ?? []);
    for (const parent of this.resolveParents(name)) {
      for (const permission of this.rolePermissions.get(parent) ?? []) {
        resolved.add(permission);
      }
    }
    return resolved;
  }

  subjectRoles(subject?: AuthSubject | string | null): string[] {
    // A missing subject never receives the default role, so null/undefined
    // cannot be granted privileges by configuration.
    if (subject === null || subject === undefined) {
      return [];
    }
    if (typeof subject === "string" && subject === "") {
      return [];
    }

    if (typeof subject === "string") {
      return [normalizeName(subject)];
    }

    const roles = unique([
      ...toArray(subject.roles),
      ...toArray(subject.role),
    ].map(normalizeName).filter(Boolean));

    if (roles.length === 0 && this.defaultRole) {
      return [this.defaultRole];
    }

    return roles;
  }

  subjectPermissions(subject?: AuthSubject | string | null): Set<string> {
    const record = typeof subject === "object" && subject ? subject : undefined;
    const direct = asSet(record?.permissions);
    const resolved = new Set(direct);
    for (const role of this.subjectRoles(subject)) {
      for (const permission of this.resolvePermissions(role)) {
        resolved.add(permission);
      }
    }
    return resolved;
  }

  can(subject: AuthSubject | string | null | undefined, permission: string | string[]): boolean {
    if (!permission) {
      return false;
    }
    const needed = asSet(permission);
    const owned = this.subjectPermissions(subject);
    for (const item of needed) {
      if (owned.has(item) || owned.has("*")) {
        continue;
      }
      if (![...owned].some((granted) => matchPermission(granted, item))) {
        return false;
      }
    }
    return needed.size > 0;
  }

  cannot(subject: AuthSubject | string | null | undefined, permission: string | string[]): boolean {
    return !this.can(subject, permission);
  }

  authorize(subject: AuthSubject | string | null | undefined, permission: string | string[]): true {
    if (!this.can(subject, permission)) {
      throw new ForbiddenError(`Missing permission: ${toArray(permission).join(", ")}`);
    }
    return true;
  }

  hasAnyRole(subject: AuthSubject | string | null | undefined, roles: string | string[]): boolean {
    const owned = new Set(this.subjectRoles(subject));
    return toArray(roles).some((role) => owned.has(normalizeName(role)));
  }

  hasAllRoles(subject: AuthSubject | string | null | undefined, roles: string | string[]): boolean {
    const owned = new Set(this.subjectRoles(subject));
    const needed = toArray(roles).map(normalizeName).filter(Boolean);
    return needed.length > 0 && needed.every((role) => owned.has(role));
  }

  snapshot(): {
    defaultRole: string | null;
    permissions: string[];
    roles: Record<string, { description: string; permissions: string[]; inherits: string[] }>;
  } {
    const roles: Record<string, { description: string; permissions: string[]; inherits: string[] }> = {};
    for (const name of this.roles.keys()) {
      roles[name] = {
        description: this.roles.get(name)?.description ?? "",
        permissions: [...(this.rolePermissions.get(name) ?? [])],
        inherits: [...(this.roleParents.get(name) ?? [])],
      };
    }
    return {
      defaultRole: this.defaultRole,
      permissions: [...this.permissions],
      roles,
    };
  }
}

export function matchPermission(granted: string, needed: string): boolean {
  if (granted === needed || granted === "*") {
    return true;
  }

  if (!granted.includes("*")) {
    return false;
  }

  // A `**` segment spans any depth ("posts.**" matches "posts.a.b"), while a `*`
  // segment stays within one level ("posts.*" matches "posts.create" only).
  const pattern = granted
    .split(".")
    .map((part) => {
      if (part === "**") return ".*";
      if (part === "*") return "[^.]+";
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("\\.");

  return new RegExp(`^${pattern}$`).test(needed);
}

export function createRBAC(options: RBACOptions = {}): RBAC {
  return new RBAC(options);
}

export function defineRoles(roles: RBACOptions["roles"]): RBAC {
  return createRBAC({ roles });
}
