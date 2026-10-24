import { describe, it } from "node:test";
import { generateKeyPairSync, sign as signRSA } from "node:crypto";
import assert from "node:assert/strict";
import {
  createAuth,
  createOAuth,
  createProvider,
  getProvider,
  encodeRefreshToken,
  hashPassword,
  verifyPassword,
  needsRehash,
  apple,
  expressAdapter,
  createMemoryRefreshStore,
  koaAdapter,
  fastifyAdapter,
  matchPermission,
  createRBAC,
  pkceVerifier,
  pkceChallenge,
  builtinProviders,
  encode,
  parseExpiresIn,
  ConfigurationError,
  InvalidTokenError,
  ProviderError,
  UnauthorizedError,
  ValidationError,
  ForbiddenError,
} from "../src/index.js";
import type { JwtPayload, RefreshRecord, UserRecord } from "../src/index.js";

const SECRET = "secret-key-for-testing-purposes-123456";

describe("token type separation", () => {
  it("rejects a refresh token used as an access token", async () => {
    const auth = createAuth({ secret: SECRET });
    const session = await auth.login({ id: 1, roles: ["admin"] });
    assert.ok(session.refreshToken);

    await assert.rejects(
      () => auth.verify(session.refreshToken!),
      (error: unknown) => error instanceof UnauthorizedError,
    );
    await assert.rejects(
      () => auth.verifyRequest({ headers: { authorization: `Bearer ${session.refreshToken}` } }),
      UnauthorizedError,
    );
  });

  it("accepts a refresh token when the caller explicitly opts in", async () => {
    const auth = createAuth({ secret: SECRET });
    const session = await auth.login({ id: 1 });
    const claims = await auth.verify(session.refreshToken!, { acceptTokenType: "refresh" });
    assert.equal(claims.typ, "refresh");
  });

  it("still accepts access tokens", async () => {
    const auth = createAuth({ secret: SECRET });
    const claims = await auth.verify((await auth.login({ id: 1 })).token);
    assert.equal(claims.typ, "access");
  });
});

describe("registration", () => {
  it("ignores caller-supplied roles", async () => {
    let created: Record<string, unknown> = {};
    const auth = createAuth({
      secret: SECRET,
      rbac: { defaultRole: "user", roles: { user: { permissions: ["read"] }, admin: { permissions: ["*"] } } },
      userStore: { create: (input) => { created = input; return { id: 9, ...input } as UserRecord; } },
    });

    const session = await auth.register({ email: "a@b.c", password: "pw", roles: ["admin"] });

    assert.deepEqual(created.roles, ["user"]);
    assert.deepEqual(session.user.roles, ["user"]);
    assert.equal(auth.can(session.payload, "anything"), false);
  });

  it("uses server-side roles from the options argument", async () => {
    let created: Record<string, unknown> = {};
    const auth = createAuth({
      secret: SECRET,
      rbac: { roles: { user: { permissions: ["read"] }, admin: { permissions: ["user.manage"] } } },
      userStore: { create: (input) => { created = input; return { id: 10, ...input } as UserRecord; } },
    });

    await auth.register({ email: "a@b.c", password: "pw", roles: ["hacker"] }, { roles: ["admin"] });

    assert.deepEqual(created.roles, ["admin"]);
  });
});

describe("token claims", () => {
  it("does not copy user.permissions into the token by default", async () => {
    const auth = createAuth({ secret: SECRET, rbac: { roles: { user: { permissions: ["read"] } } } });
    const session = await auth.login({ id: 1, roles: ["user"], permissions: ["admin:all"] });

    assert.equal(auth.can(session.payload, "admin:all"), false);
    assert.deepEqual(session.payload.permissions, ["read"]);
  });

  it("copies user.permissions when trustUserPermissions is enabled", async () => {
    const auth = createAuth({ secret: SECRET, trustUserPermissions: true });
    const session = await auth.login({ id: 1, roles: ["user"], permissions: ["beta.access"] });

    assert.equal(auth.can(session.payload, "beta.access"), true);
  });
});

describe("refresh store", () => {
  it("throws instead of silently failing when the store cannot revoke", async () => {
    const auth = createAuth({
      secret: SECRET,
      refreshStore: { save: () => {}, get: () => null },
    });
    const session = await auth.login({ id: 1 });

    await assert.rejects(() => auth.logout(session.refreshToken), ConfigurationError);
    await assert.rejects(() => auth.refresh(session.refreshToken!), ConfigurationError);
  });

  it("redeems a refresh token only once under concurrent refreshes", async () => {
    const ids = new Set<string>();
    const auth = createAuth({
      secret: SECRET,
      refreshStore: {
        save: (record: RefreshRecord) => { ids.add(record.id); },
        get: (id) => (ids.has(id) ? { id, userId: 1, tokenHash: "x", expiresAt: Date.now() + 60_000 } : null),
        consume: (id) => {
          const record = ids.has(id) ? { id, userId: 1, tokenHash: "x", expiresAt: Date.now() + 60_000 } : null;
          ids.delete(id);
          return record;
        },
        revoke: (id) => { ids.delete(id); },
      },
    });
    const { refreshToken } = await auth.login({ id: 1 });

    const settled = await Promise.allSettled([auth.refresh(refreshToken!), auth.refresh(refreshToken!)]);

    assert.equal(settled.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(settled.filter((r) => r.status === "rejected").length, 1);
  });

  it("rotates a token exactly once with the in-memory store", async () => {
    const auth = createAuth({ secret: SECRET });
    const first = await auth.login({ id: 1 });
    assert.ok(first.refreshToken);

    await auth.refresh(first.refreshToken!);
    await assert.rejects(() => auth.refresh(first.refreshToken!), UnauthorizedError);
  });

  it("rejects an access token passed to logout", async () => {
    const auth = createAuth({ secret: SECRET });
    const session = await auth.login({ id: 1 });

    await assert.rejects(() => auth.logout(session.accessToken), UnauthorizedError);
  });

  it("revokes with the configured algorithm, not the HS256 default", async () => {
    const auth = createAuth({ secret: SECRET, algorithm: "HS512" });
    const session = await auth.login({ id: 1 });

    assert.equal(await auth.revoke(session.refreshToken), true);
  });

  it("supports logout on a store that only implements consume()", async () => {
    // consume(id) and revoke(id) are interchangeable for logout, so a store
    // that can rotate must be able to log out too.
    const ids = new Set<string>();
    const auth = createAuth({
      secret: SECRET,
      refreshStore: {
        save: (record: RefreshRecord) => { ids.add(record.id); },
        get: (id) => (ids.has(id) ? { id, userId: 1, tokenHash: "h", expiresAt: Date.now() + 60_000 } : null),
        consume: (id) => {
          const record = ids.has(id) ? { id, userId: 1, tokenHash: "h", expiresAt: Date.now() + 60_000 } : null;
          ids.delete(id);
          return record;
        },
      },
    });
    const session = await auth.login({ id: 1 });

    assert.equal(await auth.logout(session.refreshToken), true);
    assert.equal(ids.size, 0, "logout removed the record via consume()");
  });

  it("explains what is missing when a store can neither consume nor revoke", async () => {
    const auth = createAuth({ secret: SECRET, refreshStore: { save: () => {}, get: () => null } });
    const session = await auth.login({ id: 1 });

    await assert.rejects(
      () => auth.logout(session.refreshToken),
      (error: unknown) => error instanceof ConfigurationError && /revoke\(\) or consume\(\)/.test((error as Error).message),
    );
    await assert.rejects(
      () => auth.refresh(session.refreshToken!),
      (error: unknown) => error instanceof ConfigurationError && /implement revoke\(\)/.test((error as Error).message),
    );
  });

  it("returns false when no token is supplied", async () => {
    const auth = createAuth({ secret: SECRET });
    assert.equal(await auth.revoke(null), false);
    assert.equal(await auth.logout(undefined), false);
  });
});

describe("token extraction", () => {
  it("reads the Authorization header from a WHATWG Headers object", async () => {
    const auth = createAuth({ secret: SECRET });
    const { accessToken } = await auth.login({ id: 1 });
    const headers = new Headers({ authorization: `Bearer ${accessToken}` });

    assert.equal(auth.extractToken({ headers } as never), accessToken);
    const claims = await auth.verifyRequest({ headers } as never);
    assert.equal(claims.sub, "1");
  });

  it("reads cookies from a WHATWG Headers object", async () => {
    const auth = createAuth({ secret: SECRET });
    const { accessToken } = await auth.login({ id: 1 });
    const headers = new Headers({ cookie: `access_token=${accessToken}` });

    assert.equal(auth.extractToken({ headers } as never), accessToken);
  });

  it("still reads uWebSockets style (key, value) forEach", async () => {
    const auth = createAuth({ secret: SECRET });
    const { accessToken } = await auth.login({ id: 1 });
    const uwsRequest = {
      getMethod: () => "GET",
      getUrl: () => "/",
      getQuery: () => "",
      forEach(cb: (key: string, value: string) => void) {
        cb("authorization", `Bearer ${accessToken}`);
      },
    };

    assert.equal(auth.extractToken(uwsRequest as never), accessToken);
  });

  it("still reads plain object headers case-insensitively", async () => {
    const auth = createAuth({ secret: SECRET });
    const { accessToken } = await auth.login({ id: 1 });

    assert.equal(auth.extractToken({ headers: { Authorization: `Bearer ${accessToken}` } }), accessToken);
  });
});

describe("adapters", () => {
  it("koa lets downstream handler errors propagate to Koa", async () => {
    const auth = createAuth({ secret: SECRET });
    const middleware = koaAdapter(auth).authenticate();
    const { accessToken } = await auth.login({ id: 1 });
    const ctx: Record<string, unknown> = {
      request: { headers: { authorization: `Bearer ${accessToken}` } },
      state: {},
      status: 0,
      body: undefined,
    };
    const failure = new Error("database is down");

    await assert.rejects(
      () => middleware(ctx as never, async () => { throw failure; }),
      (error: unknown) => error === failure,
    );
    assert.equal(ctx.status, 0, "the adapter must not write a response for downstream errors");
  });

  it("koa still converts auth failures into a response", async () => {
    const auth = createAuth({ secret: SECRET });
    const middleware = koaAdapter(auth).authenticate();
    const ctx: Record<string, unknown> = { request: { headers: {} }, state: {}, status: 0, body: undefined };

    await middleware(ctx as never, async () => { throw new Error("next must not run"); });

    assert.equal(ctx.status, 401);
    assert.equal((ctx.body as { error: string }).error, "UNAUTHORIZED");
  });

  it("koa runs next() for optional auth with no token", async () => {
    const auth = createAuth({ secret: SECRET });
    const middleware = koaAdapter(auth).authenticate({ optional: true });
    const ctx: Record<string, unknown> = { request: { headers: {} }, state: {}, status: 0, body: undefined };
    let ran = false;

    await middleware(ctx as never, async () => { ran = true; });

    assert.equal(ran, true);
    assert.equal((ctx.state as { user: unknown }).user, null);
  });

  it("fastify honours plugin-level optional", async () => {
    const auth = createAuth({ secret: SECRET });
    const decorated: Record<string, unknown> = {};
    const fastify = { decorate: (n: string, v: unknown) => { decorated[n] = v; }, decorateRequest: () => {} };

    await fastifyAdapter(auth)(fastify as never, { optional: true });

    const handler = decorated.authenticate as (o?: unknown) => (req: unknown, reply: unknown) => Promise<void>;
    const request: Record<string, unknown> = { headers: {} };
    const sent: unknown[] = [];
    const reply = { code: (_s: number) => ({ send: (b: unknown) => { sent.push(b); return b; } }) };

    await handler()(request, reply);

    assert.deepEqual(sent, [], "optional:true must swallow the missing-token error");
    assert.equal(request.user, null);
  });

  it("fastify still rejects when optional is not set", async () => {
    const auth = createAuth({ secret: SECRET });
    const decorated: Record<string, unknown> = {};
    const fastify = { decorate: (n: string, v: unknown) => { decorated[n] = v; }, decorateRequest: () => {} };

    await fastifyAdapter(auth)(fastify as never);

    const handler = decorated.authenticate as (o?: unknown) => (req: unknown, reply: unknown) => Promise<void>;
    const request: Record<string, unknown> = { headers: {} };
    const sent: unknown[] = [];
    const reply = { code: (_s: number) => ({ send: (b: unknown) => { sent.push(b); return b; } }) };

    await handler()(request, reply);

    assert.equal(sent.length, 1);
  });
});

describe("oauth provider registry", () => {
  it("does not let an alias overwrite the canonical provider entry", () => {
    const oauth = createOAuth({});
    oauth.use("google", { clientId: "canonical" });
    oauth.use("my-google", { clientId: "alias", provider: getProvider("google") });

    assert.equal(oauth.get("google").config.clientId, "canonical");
    assert.equal(oauth.get("my-google").config.clientId, "alias");
  });

  it("still aliases the provider id when nothing else claimed it", () => {
    const oauth = createOAuth({});
    oauth.use("my-google", { clientId: "alias", provider: getProvider("google") });

    assert.equal(oauth.get("google").config.clientId, "alias");
  });
});

describe("permission wildcards", () => {
  it("treats ** as spanning any depth", () => {
    assert.equal(matchPermission("posts.**", "posts.create"), true);
    assert.equal(matchPermission("posts.**", "posts.a.b"), true);
    assert.equal(matchPermission("**", "anything.at.all"), true);
  });

  it("keeps * within a single level", () => {
    assert.equal(matchPermission("posts.*", "posts.create"), true);
    assert.equal(matchPermission("posts.*", "posts.a.b"), false);
  });

  it("does not let a prefix wildcard cross a segment boundary", () => {
    assert.equal(matchPermission("posts.*", "postsx.create"), false);
    assert.equal(matchPermission("post.*", "posts.create"), false);
  });
});

describe("expiresIn validation", () => {
  it("rejects a timespan jsonwebtoken and this library would disagree on", () => {
    assert.throws(() => encode({ sub: "1" }, SECRET, { expiresIn: "1y" }), ValidationError);
    assert.throws(() => encode({ sub: "1" }, SECRET, { expiresIn: "2 hours" }), ValidationError);
    assert.throws(() => encode({ sub: "1" }, SECRET, { expiresIn: "abc" }), ValidationError);
  });

  it("accepts seconds and supported units", () => {
    assert.doesNotThrow(() => encode({ sub: "1" }, SECRET, { expiresIn: 60 }));
    assert.doesNotThrow(() => encode({ sub: "1" }, SECRET, { expiresIn: "15m" }));
    assert.doesNotThrow(() => encode({ sub: "1" }, SECRET, { expiresIn: "7d" }));
  });

  it("surfaces the same error when a login TTL is invalid", async () => {
    const auth = createAuth({ secret: SECRET });
    await assert.rejects(() => auth.login({ id: 1 }, { accessTokenTtl: "1y" }), ValidationError);
  });

  it("keeps parseExpiresIn lenient for direct callers", () => {
    assert.equal(parseExpiresIn("bogus"), 86_400);
    assert.equal(parseExpiresIn("15m"), 900);
  });
});

describe("in-memory stores", () => {
  it("exposes an atomic consume() on the default refresh store", async () => {
    const store = createMemoryRefreshStore();
    await store.save({ id: "a", userId: 1, tokenHash: "h", expiresAt: Date.now() + 60_000 });

    assert.ok(await store.consume?.("a"));
    assert.equal(await store.get("a"), null);
  });

  it("treats an expired record as absent", async () => {
    const store = createMemoryRefreshStore();
    await store.save({ id: "b", userId: 1, tokenHash: "h", expiresAt: Date.now() - 1 });

    assert.equal(await store.get("b"), null);
    assert.equal(await store.consume?.("b"), null);
  });
});

describe("rbac direct permissions", () => {
  it("still supports permissions on an explicit subject", () => {
    const auth = createAuth({ secret: SECRET, rbac: { roles: { member: { permissions: ["profile.read"] } } } });

    assert.equal(auth.can({ roles: ["member"], permissions: ["beta.access"] }, "beta.access"), true);
    assert.equal(auth.can({ roles: ["member"] }, "beta.access"), false);
  });
});

describe("forbidden paths", () => {
  it("throws ForbiddenError for a missing permission", () => {
    const auth = createAuth({ secret: SECRET, rbac: { roles: { user: { permissions: ["read"] } } } });

    assert.throws(() => auth.authorize({ roles: ["user"] }, "write"), ForbiddenError);
  });

  it("rejects an empty or missing token", async () => {
    const auth = createAuth({ secret: SECRET });
    await assert.rejects(() => auth.verify(""), UnauthorizedError);
  });

  it("keeps rejecting tokens signed with another secret", async () => {
    const auth = createAuth({ secret: SECRET });
    const other = createAuth({ secret: "a-completely-different-secret-value" });
    const foreign = (await other.login({ id: 1 })).accessToken;

    await assert.rejects(() => auth.verify(foreign), InvalidTokenError);
  });

  it("does not accept an alg=none token", async () => {
    const auth = createAuth({ secret: SECRET });
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({ sub: "1", typ: "access", exp: Math.floor(Date.now() / 1000) + 600 }),
    ).toString("base64url");

    await assert.rejects(() => auth.verify(`${header}.${body}.`), InvalidTokenError);
  });
});

describe("claims extraction", () => {
  it("isolates extractor failures", async () => {
    const auth = createAuth({ secret: SECRET });
    auth.registerExtractor("boom", () => {
      throw new Error("nope");
    });
    auth.registerExtractor("tier", (user) => (user as JwtPayload & { plan?: string }).plan ?? "free");

    const session = await auth.login({ id: 1 });

    assert.equal(session.payload.boom, null);
    assert.equal(session.payload.tier, "free");
  });
});

describe("OAuth identity safety", () => {
  function brokenProvider(profile: Record<string, unknown>) {
    const provider = createProvider({
      id: "broken",
      authorizationUrl: "https://example.test/auth",
      tokenUrl: "https://example.test/token",
      userInfoUrl: "https://example.test/me",
      profileMap: { email: "email", name: "name" },
    });
    provider.exchangeCode = async () => ({ access_token: "t" });
    provider.fetchProfile = async () => profile as never;
    return provider;
  }

  it("refuses to mint a token when the profile has no subject id", async () => {
    const auth = createAuth({
      secret: SECRET,
      oauth: { providers: { broken: { provider: brokenProvider({ email: "a@example.com" }), clientId: "x" } } },
    });

    // Without this guard every user of the provider would share the subject
    // "broken:undefined".
    await assert.rejects(
      () => auth.loginWithOAuth("broken", "?code=1", { refresh: false }),
      (error: unknown) => error instanceof ProviderError && /without a subject identifier/.test((error as Error).message),
    );
  });

  it("rejects an empty-string subject id too", async () => {
    const auth = createAuth({
      secret: SECRET,
      oauth: { providers: { broken: { provider: brokenProvider({ id: "", email: "a@example.com" }), clientId: "x" } } },
    });

    await assert.rejects(() => auth.loginWithOAuth("broken", "?code=1", { refresh: false }), ProviderError);
  });

  it("gives distinct users distinct subjects when an id is present", async () => {
    let n = 0;
    const provider = brokenProvider({});
    provider.fetchProfile = async () => ({ id: `u${++n}`, email: `${n}@example.com` });
    const auth = createAuth({
      secret: SECRET,
      oauth: { providers: { broken: { provider, clientId: "x" } } },
    });

    const a = await auth.loginWithOAuth("broken", "?code=1", { refresh: false });
    const b = await auth.loginWithOAuth("broken", "?code=1", { refresh: false });

    assert.notEqual(a.payload.sub, b.payload.sub);
    assert.match(String(a.payload.sub), /^broken:u1$/);
  });
});

describe("OAuth callback parameter shapes", () => {
  async function authFor() {
    const provider = createProvider({
      id: "shapes",
      authorizationUrl: "https://example.test/auth",
      tokenUrl: "https://example.test/token",
      userInfoUrl: "https://example.test/me",
      profileMap: { id: "sub", email: "email" },
    });
    let seenRedirect: unknown;
    provider.exchangeCode = async (_config, opts) => {
      seenRedirect = opts?.redirectUri;
      return { access_token: "t" };
    };
    provider.fetchProfile = async () => ({ id: "u1", email: "a@example.com" });
    const auth = createAuth({
      secret: SECRET,
      oauth: { redirectUri: "https://app.test/cb", providers: { shapes: { provider, clientId: "x" } } },
    });
    return { auth, getRedirect: () => seenRedirect };
  }

  const forms: Array<[string, string]> = [
    ["absolute URL", "https://app.test/cb?code=abc"],
    ["absolute path with query", "/cb?code=abc"],
    ["relative path without a leading slash", "cb?code=abc"],
    ["nested path without a leading slash", "callback?code=abc"],
    ["leading question mark", "?code=abc"],
    ["bare query string", "code=abc"],
    ["bare query string with surrounding whitespace", "  code=abc  "],
    ["bare query string with state", "code=abc&state=xyz"],
  ];

  for (const [label, params] of forms) {
    it(`accepts a ${label}`, async () => {
      const { auth } = await authFor();
      // A form carrying `state` needs a real one, otherwise the callback is
      // rejected by state validation before the code is ever used.
      let resolved = params;
      if (params.includes("state=")) {
        const { state } = await auth.getAuthorizationUrl("shapes");
        resolved = params.replace("xyz", state);
      }
      const session = await auth.loginWithOAuth("shapes", resolved, { refresh: false });
      assert.equal(session.payload.sub, "shapes:u1");
    });
  }
});

describe("password hash robustness", () => {
  const bad = [
    "scrypt$1073741824$8$1$64$YWJjZGVmZ2g$aGFzaGhhc2hoYXNoaGFzaA",
    "scrypt$-1$8$1$64$YWJj$ZGVmZ2g",
    "scrypt$0$0$0$0$YWJj$ZGVmZ2g",
    "scrypt$abc$8$1$64$YWJj$ZGVmZ2g",
    "not-a-hash",
    "",
  ];

  for (const [index, stored] of bad.entries()) {
    it(`returns false without throwing for hostile hash #${index + 1}`, async () => {
      assert.equal(await verifyPassword("pw", stored), false);
    });
  }
});

describe("token confusion", () => {
  it("rejects an access token at refresh()", async () => {
    const auth = createAuth({ secret: SECRET });
    const session = await auth.login({ id: 1 });
    await assert.rejects(() => auth.refresh(session.accessToken), UnauthorizedError);
  });

  it("rejects a token signed with a different algorithm", async () => {
    const wide = createAuth({ secret: SECRET, algorithm: "HS512" });
    const narrow = createAuth({ secret: SECRET, algorithm: "HS256" });
    const session = await wide.login({ id: 1 });
    await assert.rejects(() => narrow.verify(session.accessToken), InvalidTokenError);
  });

  it("keeps access and refresh keys separate when refreshSecret is set", async () => {
    const auth = createAuth({ secret: SECRET, refreshSecret: "r".repeat(32) });
    const session = await auth.login({ id: 1 });
    await assert.rejects(
      () => auth.verify(session.refreshToken!, { acceptTokenType: "refresh" }),
      InvalidTokenError,
    );
  });

  it("rejects a typ-less token at refresh()", async () => {
    const auth = createAuth({ secret: SECRET });
    const bare = auth.sign({ sub: "1", jti: "invented" });
    await assert.rejects(() => auth.refresh(bare), UnauthorizedError);
  });
});

describe("PKCE helpers are publicly available", () => {
  // A public client implementing PKCE by hand has no other way to generate a
  // verifier or compute the S256 challenge.
  it("exposes pkceVerifier and pkceChallenge from the package entry point", () => {
    assert.equal(typeof pkceVerifier, "function");
    assert.equal(typeof pkceChallenge, "function");
  });

  it("produces the RFC 7636 section 4.1 S256 challenge", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    assert.equal(pkceChallenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generates base64url verifiers of a legal length", () => {
    for (let i = 0; i < 5; i++) {
      assert.match(pkceVerifier(), /^[A-Za-z0-9_-]{43,128}$/);
    }
  });
});

describe("defaultRole scope", () => {
  // Documented behavior, pinned deliberately: a null subject is assigned
  // defaultRole, so defaultRole is a grant to anonymous callers. The bundled
  // adapters guard for a missing user before calling can(); custom middleware
  // must do the same.
  const rbac = createRBAC({ defaultRole: "guest", roles: { guest: { permissions: ["public.read"] } } });

  it("assigns defaultRole to a subject with no roles", () => {
    assert.equal(rbac.can({}, "public.read"), true);
  });

  it("does not assign defaultRole to a null subject", () => {
    assert.equal(rbac.can(null, "public.read"), false);
    assert.equal(rbac.can(undefined, "public.read"), false);
  });

  it("means defaultRole must stay unprivileged", () => {
    const danger = createRBAC({ defaultRole: "admin", roles: { admin: { permissions: ["*"] } } });
    assert.equal(danger.can(null, "anything"), false);
    assert.equal(danger.can({}, "anything"), true);
  });
});

describe("RBAC robustness", () => {
  it("terminates on an inheritance cycle", () => {
    const rbac = createRBAC({
      roles: {
        a: { permissions: ["a.read"], inherits: "b" },
        b: { permissions: ["b.read"], inherits: "a" },
      },
    });
    assert.deepEqual([...rbac.resolvePermissions("a")].sort(), ["a.read", "b.read"]);
  });

  it("resolves a deep inheritance chain", () => {
    const roles: Record<string, { permissions: string[]; inherits?: string }> = { r0: { permissions: ["p0"] } };
    for (let i = 1; i < 60; i++) roles[`r${i}`] = { permissions: [`p${i}`], inherits: `r${i - 1}` };
    assert.equal(createRBAC({ roles }).resolvePermissions("r59").size, 60);
  });

  it("does not leak permissions between sibling roles", () => {
    const rbac = createRBAC({ roles: { a: { permissions: ["a.read"] }, c: { permissions: ["c.read"] } } });
    assert.equal(rbac.can({ roles: ["c"] }, "a.read"), false);
  });

  it("denies an empty, blank, or whitespace permission list", () => {
    const rbac = createRBAC({ roles: { u: { permissions: ["p"] } } });
    const subject = { roles: ["u"] };
    assert.equal(rbac.can(subject, []), false);
    assert.equal(rbac.can(subject, ""), false);
    assert.equal(rbac.can(subject, "   "), false);
  });

  it("requires every permission in a list, and lets a wildcard satisfy them", () => {
    const partial = createRBAC({ roles: { u: { permissions: ["posts.read"] } } });
    assert.equal(partial.can({ roles: ["u"] }, ["posts.read", "posts.write"]), false);
    const wildcard = createRBAC({ roles: { u: { permissions: ["posts.*"] } } });
    assert.equal(wildcard.can({ roles: ["u"] }, ["posts.read", "posts.write"]), true);
  });

  it("keeps wildcards inside their segment", () => {
    const matrix: Array<[string, string, boolean]> = [
      ["*", "anything.at.all", true],
      ["posts.*", "posts", false],
      ["posts.*", "posts.a.b", false],
      ["posts.*", "postsx.create", false],
      ["posts.**", "posts.a.b.c", true],
      ["posts.**", "comments.a", false],
      ["a.b.c", "a.b", false],
    ];
    for (const [granted, needed, expected] of matrix) {
      assert.equal(matchPermission(granted, needed), expected, `${granted} vs ${needed}`);
    }
  });
});

describe("built-in providers", () => {
  it("every provider has parseable endpoints and at least one scope", () => {
    for (const [id, provider] of Object.entries(builtinProviders)) {
      assert.ok(provider.id, `${id} has an id`);
      assert.doesNotThrow(() => new URL(provider.authorizationUrl), `${id} authorizationUrl`);
      assert.doesNotThrow(() => new URL(provider.tokenUrl), `${id} tokenUrl`);
      assert.ok(provider.scopes.length > 0, `${id} has scopes`);
    }
  });
});

describe("reserved claims cannot be overridden", () => {
  // A token minted for user 42 must never carry sub "admin". These claims are
  // derived from the user record and RBAC, so nothing caller-supplied may
  // replace them.
  for (const name of ["sub", "userId", "roles", "permissions", "typ", "iss", "aud", "exp", "jti"]) {
    it(`rejects an extractor named "${name}"`, () => {
      const auth = createAuth({ secret: SECRET });
      assert.throws(
        () => auth.registerExtractor(name, () => "x" as never),
        (error: unknown) => error instanceof ValidationError && /reserved/.test((error as Error).message),
      );
    });
  }

  it("rejects additionalClaims that override a reserved claim", async () => {
    const auth = createAuth({ secret: SECRET });
    for (const claim of [{ sub: "admin" }, { userId: 999 }, { roles: ["admin"] }, { permissions: ["*"] }]) {
      await assert.rejects(() => auth.login({ id: 42 }, { additionalClaims: claim }), ValidationError);
    }
  });

  it("strips reserved keys returned by an object extractor", async () => {
    const auth = createAuth({ secret: SECRET, rbac: { roles: { user: { permissions: ["read"] } } } });
    auth.registerExtractor("meta", () => ({ tier: "gold", sub: "evil", roles: ["admin"] }) as never);

    const session = await auth.login({ id: 7, roles: ["user"] });

    assert.equal(session.payload.sub, "7");
    assert.deepEqual(session.payload.roles, ["user"]);
    assert.equal(session.payload.tier, "gold", "non-reserved keys still land");
  });

  it("keeps non-reserved extractors and additionalClaims working", async () => {
    const auth = createAuth({ secret: SECRET });
    auth.registerExtractor("tier", () => "gold");
    auth.registerExtractor("name", () => "Renamed");

    const session = await auth.login({ id: 7 }, { additionalClaims: { tenantId: "acme" } });

    assert.equal(session.payload.tier, "gold");
    assert.equal(session.payload.name, "Renamed");
    assert.equal(session.payload.tenantId, "acme");
    assert.equal(session.payload.sub, "7");
  });
});

describe("Apple id_token verification", () => {
  // A real keypair, so these tests exercise the actual RSA signature check
  // rather than a stub. The public key is handed to the provider through the
  // `jwks` config, which is the same injection point an application with its
  // own key cache would use, and it keeps the suite off the network.
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  const KID = "test-key";
  const jwks = { keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] };
  const config = { clientId: "com.example.app", jwks };
  const ISSUER = "https://appleid.apple.com";
  const now = () => Math.floor(Date.now() / 1000);

  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

  function sign(
    claims: Record<string, unknown>,
    options: { kid?: string | undefined; alg?: string; key?: typeof privateKey } = {},
  ): string {
    const kid = "kid" in options ? options.kid : KID;
    const header: Record<string, unknown> = { alg: options.alg ?? "RS256" };
    if (kid !== undefined) {
      header.kid = kid;
    }
    const head = b64(header);
    const body = b64(claims);
    const signature = signRSA("RSA-SHA256", Buffer.from(`${head}.${body}`, "utf8"), options.key ?? privateKey);
    return `${head}.${body}.${signature.toString("base64url")}`;
  }

  const valid = (over: Record<string, unknown> = {}) => ({
    iss: ISSUER,
    aud: "com.example.app",
    sub: "u1",
    exp: now() + 3600,
    ...over,
  });

  it("accepts a correctly signed id_token", async () => {
    const profile = await apple.fetchProfile(config, { id_token: sign(valid()) });
    assert.equal(profile.id, "u1");
  });

  it("accepts an audience array containing the clientId", async () => {
    const profile = await apple.fetchProfile(config, {
      id_token: sign(valid({ aud: ["x", "com.example.app"], sub: "u2" })),
    });
    assert.equal(profile.id, "u2");
  });

  it("rejects a token whose signature does not match the payload", async () => {
    // The signature covers the header and payload, so editing the payload
    // after signing must invalidate it. This is the attack the whole
    // verification step exists to stop.
    const [head, , sig] = sign(valid()).split(".") as [string, string, string];
    const tampered = `${head}.${b64(valid({ sub: "attacker" }))}.${sig}`;
    await assert.rejects(() => apple.fetchProfile(config, { id_token: tampered }), ProviderError);
  });

  it("rejects a token signed by a different key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    await assert.rejects(
      () => apple.fetchProfile(config, { id_token: sign(valid(), { key: other }) }),
      ProviderError,
    );
  });

  it("rejects an unknown kid", async () => {
    await assert.rejects(
      () => apple.fetchProfile(config, { id_token: sign(valid(), { kid: "some-other-key" }) }),
      ProviderError,
    );
  });

  it('rejects alg: "none"', async () => {
    const unsigned = `${b64({ alg: "none", kid: KID })}.${b64(valid())}.`;
    await assert.rejects(() => apple.fetchProfile(config, { id_token: unsigned }), ProviderError);
  });

  it("rejects a token with no kid", async () => {
    await assert.rejects(
      () => apple.fetchProfile(config, { id_token: sign(valid(), { kid: undefined }) }),
      ProviderError,
    );
  });

  it("rejects a wrong issuer", async () => {
    await assert.rejects(
      () => apple.fetchProfile(config, { id_token: sign(valid({ iss: "https://evil.example" })) }),
      ProviderError,
    );
  });

  it("rejects an audience issued to another app", async () => {
    await assert.rejects(
      () => apple.fetchProfile(config, { id_token: sign(valid({ aud: "com.other.app" })) }),
      ProviderError,
    );
  });

  it("rejects an expired id_token", async () => {
    await assert.rejects(
      () => apple.fetchProfile(config, { id_token: sign(valid({ exp: now() - 60 })) }),
      ProviderError,
    );
  });

  it("rejects an id_token with no exp, rather than treating it as valid forever", async () => {
    const { exp: _exp, ...noExp } = valid();
    await assert.rejects(
      () => apple.fetchProfile(config, { id_token: sign(noExp) }),
      ProviderError,
    );
  });

  it("rejects a malformed id_token", async () => {
    await assert.rejects(() => apple.fetchProfile(config, { id_token: "not-a-jwt" }), ProviderError);
  });

  it("checks the signature before trusting the claims", async () => {
    // A correctly signed token for a different app still fails on aud, which
    // only makes sense because the payload was verified first.
    await assert.rejects(
      () => apple.fetchProfile(config, { id_token: sign(valid({ aud: "com.other.app" })) }),
      /audience/,
    );
  });
});

describe("Express adapter", () => {
  function makeRes() {
    return {
      // The adapter calls res.status(code); record what it was called with.
      statusCode: undefined as number | undefined,
      body: undefined as unknown,
      status(code: number) { this.statusCode = code; return this; },
      send(body: unknown) { this.body = body; return this; },
      json(body: unknown) { this.body = body; return this; },
    };
  }

  it("401s without a token and does not call next", async () => {
    const auth = createAuth({ secret: SECRET, rbac: { roles: { user: { permissions: ["me.read"] } } } });
    const { authenticate } = expressAdapter(auth);
    const req = { headers: {} } as Record<string, unknown>;
    const res = makeRes();
    let nextCalls = 0;

    await authenticate()(req, res, () => { nextCalls += 1; });

    assert.equal(res.statusCode, 401);
    assert.equal(nextCalls, 0);
  });

  it("populates req.user and calls next on a valid token", async () => {
    const auth = createAuth({ secret: SECRET });
    const { authenticate } = expressAdapter(auth);
    const { accessToken } = await auth.login({ id: 1 });
    const req = { headers: { authorization: `Bearer ${accessToken}` } } as Record<string, unknown>;
    const res = makeRes();
    let nextCalls = 0;

    await authenticate()(req, res, () => { nextCalls += 1; });

    assert.equal((req.user as { sub?: string } | undefined)?.sub, "1");
    assert.equal(nextCalls, 1);
  });

  it("routes the error to next() with passthrough and writes no response", async () => {
    const auth = createAuth({ secret: SECRET });
    const { authenticate } = expressAdapter(auth);
    const req = { headers: {} } as Record<string, unknown>;
    const res = makeRes();
    const errors: unknown[] = [];

    await authenticate({ passthrough: true })(req, res, (error) => { errors.push(error); });

    assert.equal(errors.length, 1);
    assert.equal(res.statusCode, undefined, "passthrough must not write a response");
  });

  it("lets an anonymous request through with optional", async () => {
    const auth = createAuth({ secret: SECRET });
    const { authenticate } = expressAdapter(auth);
    const req = { headers: {} } as Record<string, unknown>;
    const res = makeRes();
    let nextCalls = 0;

    await authenticate({ optional: true })(req, res, () => { nextCalls += 1; });

    assert.equal(res.statusCode, undefined);
    assert.equal(req.user, null);
    assert.equal(nextCalls, 1);
  });

  it("403s a missing permission and calls next on a granted one", async () => {
    const auth = createAuth({ secret: SECRET, rbac: { roles: { user: { permissions: ["me.read"] } } } });
    const { requirePermission, requireRole } = expressAdapter(auth);

    const denied = makeRes();
    await requirePermission("admin.x")({ user: { sub: "1", permissions: ["me.read"] } }, denied);
    assert.equal(denied.statusCode, 403);

    const allowed = makeRes();
    let nextCalls = 0;
    await requirePermission("me.read")({ user: { sub: "1", permissions: ["me.read"] } }, allowed, () => { nextCalls += 1; });
    assert.equal(allowed.statusCode, undefined);
    assert.equal(nextCalls, 1);

    const roleDenied = makeRes();
    await requireRole("admin")({ user: { roles: ["user"] } }, roleDenied);
    assert.equal(roleDenied.statusCode, 403);
  });
});

describe("password hashing cost is bounded", () => {
  // Every one of these numbers is read out of a stored hash string, so each is
  // attacker-influenced wherever an attacker can write a user row. Node's
  // maxmem guard only covers 128 * N * r, which left keyLength and parallelism
  // unbounded: a single crafted hash cost 25s of CPU on a default config.
  const salt = Buffer.alloc(16).toString("base64url");
  const crafted = (...params: [number, number, number, number]) =>
    ["scrypt", ...params.slice(0, 4), salt, "AAAA"].join("$");

  it("rejects an oversized keyLength without running scrypt", async () => {
    const started = Date.now();
    assert.equal(await verifyPassword("guess", crafted(16384, 8, 1, 2 ** 30)), false);
    // The point of the bound: this used to burn ~25 seconds here.
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms, expected the bomb to be refused`);
  });

  it("rejects the other unbounded parameters", async () => {
    for (const params of [
      [2 ** 30, 8, 1, 64], // memory bomb
      [16384, 2 ** 30, 1, 64], // block size bomb
      [16384, 8, 2 ** 25, 64], // parallelism bomb
      [2 ** 31, 8, 1, 2 ** 30],
    ]) {
      assert.equal(await verifyPassword("guess", crafted(params[0], params[1], params[2], params[3])), false);
    }
  });

  it("rejects a downgrade to trivially cheap parameters", async () => {
    // A stored hash that verifies instantly is a brute-force shortcut.
    for (const params of [[2, 1, 1, 64], [1, 1, 1, 64], [0, 1, 1, 64]]) {
      assert.equal(await verifyPassword("guess", crafted(params[0], params[1], params[2], params[3])), false);
    }
  });

  it("rejects non-integer and non-power-of-two parameters", async () => {
    assert.equal(await verifyPassword("guess", crafted(1000, 8, 1, 64)), false);
    assert.equal(await verifyPassword("guess", crafted(16384, 8, 1, 12)), false);
    assert.equal(await verifyPassword("guess", "scrypt$abc$8$1$64$AAAA$AAAA"), false);
  });

  it("reports a bomb hash as needing a rehash rather than a valid hash", () => {
    assert.equal(needsRehash(crafted(2 ** 30, 8, 1, 2 ** 30)), true);
  });

  it("refuses out-of-range options at hash time with a clear error", async () => {
    for (const options of [
      { keyLength: 1e9 },
      { cost: 2 ** 30 },
      { cost: 3 },
      { cost: 1000 },
      { blockSize: 512 },
      { parallelism: 1e6 },
      { saltBytes: 9999 },
    ]) {
      await assert.rejects(() => hashPassword("pw", options), ValidationError);
    }
  });

  it("still accepts legitimate cost increases inside the work budget", async () => {
    for (const options of [{}, { cost: 32768, blockSize: 4 }, { keyLength: 128 }, { cost: 4096, parallelism: 4 }]) {
      const hash = await hashPassword("pw", options);
      assert.equal(await verifyPassword("pw", hash), true, `failed for ${JSON.stringify(options)}`);
      assert.equal(await verifyPassword("other", hash), false);
    }
  });
});

describe("refresh tokens must be revocable", () => {
  it("refuses a refresh token with no jti", async () => {
    // encodeRefreshToken is a public export, so a jti-less token is reachable
    // by anyone holding the secret. Accepting one issued a session that no
    // revocation list could ever reach, including after logout.
    const auth = createAuth({ secret: SECRET });
    const jtiLess = encodeRefreshToken({ sub: "42", userId: 42, roles: ["user"] }, SECRET, { expiresIn: "30d" });
    await assert.rejects(() => auth.refresh(jtiLess), UnauthorizedError);
  });

  it("still refuses it as an access token", async () => {
    const auth = createAuth({ secret: SECRET });
    const jtiLess = encodeRefreshToken({ sub: "42", userId: 42, roles: ["user"] }, SECRET, { expiresIn: "30d" });
    await assert.rejects(() => auth.verify(jtiLess), UnauthorizedError);
  });

  it("refuses it after logout, which was previously impossible", async () => {
    const auth = createAuth({ secret: SECRET });
    const jtiLess = encodeRefreshToken({ sub: "42", userId: 42, roles: ["user"] }, SECRET, { expiresIn: "30d" });
    await auth.logout((await auth.login({ id: 42 })).refreshToken);
    await assert.rejects(() => auth.refresh(jtiLess), UnauthorizedError);
  });
});

describe("query-string token extraction is opt-in", () => {
  it("ignores ?access_token= by default", async () => {
    const auth = createAuth({ secret: SECRET });
    const { accessToken } = await auth.login({ id: 1 });
    const request = { headers: {}, query: { access_token: accessToken } };
    // A token in a URL lands in every access log, proxy log, browser history,
    // and outgoing Referer header.
    assert.equal(auth.extractToken(request), null);
    await assert.rejects(() => auth.verifyRequest(request), UnauthorizedError);
  });

  it("reads it when explicitly enabled", async () => {
    const auth = createAuth({ secret: SECRET });
    const { accessToken } = await auth.login({ id: 1 });
    const request = { headers: {}, query: { access_token: accessToken } };
    assert.equal(auth.extractToken(request, { query: true }), accessToken);
  });

  it("still reads header and cookie tokens by default", async () => {
    const auth = createAuth({ secret: SECRET });
    const { accessToken } = await auth.login({ id: 1 });
    assert.equal(auth.extractToken({ headers: { authorization: `Bearer ${accessToken}` } }), accessToken);
    assert.equal(auth.extractToken({ headers: { cookie: `access_token=${accessToken}` } }), accessToken);
  });
});

describe("session revocation", () => {
  function makeStore() {
    const versions = new Map<string, number>();
    return {
      versions,
      store: {
        getVersion: (id: string | number) => versions.get(String(id)) ?? 0,
        bumpVersion: (id: string | number) => {
          const next = (versions.get(String(id)) ?? 0) + 1;
          versions.set(String(id), next);
          return next;
        },
        revoked: new Set<string>(),
        revokeSession(jti: string) {
          this.revoked.add(jti);
        },
      },
    };
  }

  it("stamps a session version and rejects the token once it is bumped", async () => {
    const { store } = makeStore();
    const auth = createAuth({ secret: SECRET, sessionStore: store });
    const session = await auth.login({ id: 1, roles: ["user"] });

    assert.equal(session.payload.sv, 0);
    assert.equal((await auth.verify(session.accessToken)).sub, "1");

    assert.equal(await auth.revokeAllSessions(1), true);
    await assert.rejects(() => auth.verify(session.accessToken), UnauthorizedError);
  });

  it("stops a revoked session from minting a new access token", async () => {
    // Without this the revocation is cosmetic: a stolen refresh token just
    // refreshes into a working session.
    const { store } = makeStore();
    const auth = createAuth({ secret: SECRET, sessionStore: store });
    const session = await auth.login({ id: 1, roles: ["user"] });

    await auth.revokeAllSessions(1);
    await assert.rejects(() => auth.refresh(session.refreshToken as string), UnauthorizedError);
  });

  it("lets a login after revocation work, and only affects that user", async () => {
    const { store } = makeStore();
    const auth = createAuth({ secret: SECRET, sessionStore: store });
    await auth.login({ id: 1 });
    await auth.revokeAllSessions(1);

    const fresh = await auth.login({ id: 1 });
    const other = await auth.login({ id: 2 });
    assert.equal(fresh.payload.sv, 1);
    assert.equal((await auth.verify(fresh.accessToken)).sub, "1");
    assert.equal((await auth.verify(other.accessToken)).sub, "2");
  });

  it("normalizes numeric and string user ids to the same version", async () => {
    const { store } = makeStore();
    const auth = createAuth({ secret: SECRET, sessionStore: store });
    const session = await auth.login({ id: 42 });
    await auth.revokeAllSessions("42");
    await assert.rejects(() => auth.verify(session.accessToken), UnauthorizedError);
  });

  it("leaves tokens unchanged and revocation a no-op when no store is configured", async () => {
    const auth = createAuth({ secret: SECRET });
    const session = await auth.login({ id: 1 });
    assert.equal(session.payload.sv, undefined);
    assert.equal((await auth.verify(session.accessToken)).sub, "1");
    assert.equal(await auth.revokeAllSessions(1), false, "must not silently claim to have revoked");
  });

  it("refuses to let a caller forge a session version", async () => {
    const { store } = makeStore();
    const auth = createAuth({ secret: SECRET, sessionStore: store });
    await assert.rejects(() => auth.login({ id: 1 }, { additionalClaims: { sv: 0 } }), ValidationError);
  });
});
