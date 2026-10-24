import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as api from "../src/index.js";

describe("public api", () => {
  it("exports core constructors and factories", () => {
    assert.equal(typeof api.createAuth, "function");
    assert.equal(typeof api.createMemorySessionStore, "function");
    assert.equal(typeof api.Auth, "function");
    assert.equal(typeof api.createRBAC, "function");
    assert.equal(typeof api.createOAuth, "function");
    assert.equal(typeof api.createProvider, "function");
    assert.equal(typeof api.encode, "function");
    assert.equal(typeof api.decode, "function");
    assert.equal(typeof api.hashPassword, "function");
    assert.equal(typeof api.expressAdapter, "function");
    assert.equal(typeof api.fastifyAdapter, "function");
    assert.equal(typeof api.koaAdapter, "function");
    assert.equal(typeof api.uwsAdapter, "function");
    assert.equal(typeof api.snapshotUwsRequest, "function");
  });

  it("exports social providers", () => {
    const exported = api as Record<string, { id?: string }>;
    for (const name of [
      "google",
      "github",
      "instagram",
      "facebook",
      "twitter",
      "discord",
      "apple",
      "linkedin",
      "microsoft",
    ]) {
      assert.equal(exported[name].id === name || exported[name].id === "twitter", true);
    }
  });

  it("exports error classes", () => {
    const exported = api as Record<string, unknown>;
    for (const name of [
      "AuthError",
      "InvalidTokenError",
      "TokenExpiredError",
      "UnauthorizedError",
      "ForbiddenError",
      "ConfigurationError",
      "OAuthError",
      "ProviderError",
      "ValidationError",
    ]) {
      assert.equal(typeof exported[name], "function");
    }
  });
});
