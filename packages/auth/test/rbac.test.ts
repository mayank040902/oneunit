import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRBAC, defineRoles, matchPermission, ForbiddenError, ValidationError } from "../src/index.js";

describe("rbac", () => {
  it("defines consumer roles and inherited permissions", () => {
    const rbac = createRBAC({
      defaultRole: "viewer",
      roles: {
        viewer: { permissions: ["post.read"] },
        editor: { inherits: "viewer", permissions: ["post.write"] },
        admin: { inherits: "editor", permissions: ["post.delete", "user.manage"] },
      },
    });

    assert.deepEqual(rbac.getRoles().sort(), ["admin", "editor", "viewer"]);
    assert.equal(rbac.can({ roles: ["viewer"] }, "post.read"), true);
    assert.equal(rbac.can({ roles: ["viewer"] }, "post.write"), false);
    assert.equal(rbac.can({ roles: ["editor"] }, "post.read"), true);
    assert.equal(rbac.can({ roles: ["editor"] }, "post.write"), true);
    assert.equal(rbac.can({ roles: ["admin"] }, "user.manage"), true);
    assert.equal(rbac.can({ roles: ["admin"] }, "post.write"), true);
  });

  it("supports wildcard permissions", () => {
    const rbac = defineRoles({
      owner: { permissions: ["*"] },
      billing: { permissions: ["invoice.*"] },
    });

    assert.equal(rbac.can({ roles: ["owner"] }, "anything.here"), true);
    assert.equal(rbac.can({ roles: ["billing"] }, "invoice.read"), true);
    assert.equal(rbac.can({ roles: ["billing"] }, "invoice.write"), true);
    assert.equal(rbac.can({ roles: ["billing"] }, "user.delete"), false);
  });

  it("grants and revokes permissions", () => {
    const rbac = createRBAC();
    rbac.addRole("member");
    rbac.grant("member", ["comment.create", "comment.read"]);
    assert.equal(rbac.can({ role: "member" }, "comment.create"), true);
    rbac.revoke("member", "comment.create");
    assert.equal(rbac.can({ role: "member" }, "comment.create"), false);
    assert.equal(rbac.can({ role: "member" }, "comment.read"), true);
  });

  it("authorize throws ForbiddenError", () => {
    const rbac = createRBAC({ roles: { user: { permissions: ["read"] } } });
    assert.throws(() => rbac.authorize({ role: "user" }, "write"), ForbiddenError);
    assert.equal(rbac.authorize({ role: "user" }, "read"), true);
  });

  it("checks role membership", () => {
    const rbac = createRBAC({ roles: { a: {}, b: {} } });
    const subject = { roles: ["a"] };
    assert.equal(rbac.hasAnyRole(subject, ["b", "a"]), true);
    assert.equal(rbac.hasAllRoles(subject, ["a", "b"]), false);
    assert.equal(rbac.hasAllRoles(subject, "a"), true);
  });

  it("uses default role when subject has none", () => {
    const rbac = createRBAC({
      defaultRole: "guest",
      roles: { guest: { permissions: ["public.read"] } },
    });
    assert.equal(rbac.can({}, "public.read"), true);
    assert.equal(rbac.can(null, "public.read"), false);
    assert.equal(rbac.can(undefined, "public.read"), false);
  });

  it("rejects empty role names", () => {
    const rbac = createRBAC();
    assert.throws(() => rbac.addRole(""), ValidationError);
    assert.throws(() => rbac.addPermission(""), ValidationError);
  });

  it("snapshots configuration", () => {
    const rbac = createRBAC({
      roles: { writer: { description: "can write", permissions: ["doc.write"] } },
    });
    const snapshot = rbac.snapshot();
    assert.deepEqual(snapshot.roles.writer.permissions, ["doc.write"]);
  });

  it("matches permission patterns", () => {
    assert.equal(matchPermission("*", "a.b"), true);
    assert.equal(matchPermission("post.*", "post.read"), true);
    assert.equal(matchPermission("post.*", "comment.read"), false);
    assert.equal(matchPermission("post.read", "post.read"), true);
  });
});
