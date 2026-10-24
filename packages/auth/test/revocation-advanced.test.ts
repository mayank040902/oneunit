import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAuth, createMemorySessionStore, TokenExpiredError, UnauthorizedError } from "../src/index.js";
// jsonwebtoken is ESM namespace import
import jwt from "jsonwebtoken";

const SECRET = "secret-key-for-testing-purposes-123456";

describe("advanced session revocation", () => {
  it("accepts a valid token before revocation", async () => {
    const auth = createAuth({ secret: SECRET, sessionStore: createMemorySessionStore() });
    const session = await auth.login({ id: 1, roles: ["user"] });
    assert.equal((await auth.verify(session.accessToken)).sub, "1");
  });

  it("rejects tokens from the revoked session but keeps another session valid", async () => {
    const auth = createAuth({ secret: SECRET, sessionStore: createMemorySessionStore() });
    const first = await auth.login({ id: 1, roles: ["user"] });
    const second = await auth.login({ id: 1, roles: ["user"] });

    assert.equal(await auth.revokeSession(String(first.payload.sid)), true);
    await assert.rejects(() => auth.verify(first.accessToken), UnauthorizedError);
    assert.equal((await auth.verify(second.accessToken)).sub, "1");

    await assert.rejects(() => auth.refresh(first.refreshToken as string), UnauthorizedError);
    const refreshed = await auth.refresh(second.refreshToken as string);
    assert.ok(refreshed.accessToken);
  });

  it("invalidates all sessions on user-wide revocation", async () => {
    const auth = createAuth({ secret: SECRET, sessionStore: createMemorySessionStore() });
    const first = await auth.login({ id: 1, roles: ["user"] });
    const second = await auth.login({ id: 1, roles: ["user"] });

    assert.equal(await auth.revokeAllSessions(1), true);
    await assert.rejects(() => auth.verify(first.accessToken), UnauthorizedError);
    await assert.rejects(() => auth.verify(second.accessToken), UnauthorizedError);
  });

  it("does not affect a different user", async () => {
    const auth = createAuth({ secret: SECRET, sessionStore: createMemorySessionStore() });
    const session = await auth.login({ id: 1, roles: ["user"] });
    await auth.revokeAllSessions(2);
    assert.equal((await auth.verify(session.accessToken)).sub, "1");
  });

  it("rejects expired access tokens", async () => {
    const auth = createAuth({ secret: SECRET, sessionStore: createMemorySessionStore() });
    const token = jwt.sign(
      { sub: "1", userId: 1, typ: "access", sv: 0, sid: "missing" },
      SECRET,
      { algorithm: "HS256", expiresIn: "-1m" },
    );
    await assert.rejects(() => auth.verify(token), TokenExpiredError);
  });

  it("fails securely when the revocation check throws", async () => {
    const store = createMemorySessionStore();
    store.isSessionRevoked = async () => {
      throw new Error("store offline");
    };
    const auth = createAuth({ secret: SECRET, sessionStore: store });
    const session = await auth.login({ id: 1, roles: ["user"] });
    await assert.rejects(() => auth.verify(session.accessToken));
  });

  it("revokes access tokens on logout when a session store is configured", async () => {
    const auth = createAuth({ secret: SECRET, sessionStore: createMemorySessionStore() });
    const session = await auth.login({ id: 1, roles: ["user"] });
    assert.equal(await auth.logout(session.refreshToken), true);
    await assert.rejects(() => auth.verify(session.accessToken), UnauthorizedError);
  });

  it("retains stateless behavior without a session store", async () => {
    const auth = createAuth({ secret: SECRET });
    const session = await auth.login({ id: 1, roles: ["user"] });
    assert.equal(session.payload.sv, undefined);
    assert.equal(session.payload.sid, undefined);
    assert.equal(await auth.revokeAllSessions(1), false);
    assert.equal((await auth.verify(session.accessToken)).sub, "1");
  });
});

describe("shared store revocation", () => {
  it("honors revocation across independent Auth instances", async () => {
    const store = createMemorySessionStore();
    const authA = createAuth({ secret: SECRET, sessionStore: store });
    const authB = createAuth({ secret: SECRET, sessionStore: store });
    const session = await authA.login({ id: 1, roles: ["user"] });

    assert.equal(await authB.revokeSession(String(session.payload.sid)), true);
    await assert.rejects(() => authB.verify(session.accessToken), UnauthorizedError);
  });
});
