# @oneunit/auth

Framework-agnostic TypeScript authentication for Node.js. Use it from a plain script or plug it into Express, Fastify, Koa, or uWebSockets.js.

[![CI](https://github.com/mayank040902/framework/actions/workflows/auth.yml/badge.svg)](https://github.com/mayank040902/framework/actions/workflows/auth.yml)
[![npm](https://img.shields.io/npm/v/@oneunit/auth.svg)](https://www.npmjs.com/package/@oneunit/auth)
[![license](https://img.shields.io/npm/l/@oneunit/auth.svg)](./LICENSE)

Monorepo: https://github.com/mayank040902/framework

- JWT access and refresh tokens via `jsonwebtoken` (HS256 by default)
- Generic RBAC: you define roles and permissions
- Password hashing with scrypt
- Social login: Google, GitHub, Instagram, Facebook, X/Twitter, Discord, Apple, LinkedIn, Microsoft, Reddit, Twitch, Slack, Spotify, TikTok
- Works standalone or with HTTP frameworks

Requires Node.js 20+. Single runtime dependency: `jsonwebtoken`.

Docs: [README](./README.md) · [ARCHITECTURE](./docs/ARCHITECTURE.md) · [FEATURES](./docs/features.md) · [CHANGELOG](./CHANGELOG.md) · [Security](../../docs/security.md)

Upgrading from 1.x? See the [2.0.0 migration notes](./CHANGELOG.md#migration).

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [JWT helpers](#jwt-helpers)
- [RBAC](#rbac)
- [Passwords](#passwords)
- [Social login](#social-login)
- [Framework adapters](#framework-adapters)
- [Refresh tokens](#refresh-tokens)
- [Utilities](#utilities)
- [Errors](#errors)
- [API reference](#api-reference)
- [Examples](#examples)
- [Scripts](#scripts)
- [License](#license)

## Install

```bash
npm install @oneunit/auth
```

## Quick start

```ts
import { createAuth } from "@oneunit/auth";

const auth = createAuth({
  secret: process.env.AUTH_SECRET,
  issuer: "my-app",
  accessTokenTtl: "15m",
  refreshTokenTtl: "7d",
  rbac: {
    defaultRole: "member",
    roles: {
      member: { permissions: ["profile.read"] },
      editor: { inherits: "member", permissions: ["post.write"] },
      admin: { inherits: "editor", permissions: ["user.manage"] },
    },
  },
});

const { accessToken, refreshToken, payload } = await auth.login({
  id: 42,
  email: "ada@example.com",
  roles: ["editor"],
});

const claims = await auth.verify(accessToken);
auth.can(claims, "post.write");
```

There are no built-in product roles. Pass whatever role names your app uses.

## JWT helpers

Use these without creating an `Auth` instance:

```js
import { encode, decode, decodeUnsafe } from "@oneunit/auth";

const token = encode(
  { userId: 123 },
  process.env.AUTH_SECRET,
  { expiresIn: "1h", subject: "123" },
);

const claims = decode(token, process.env.AUTH_SECRET);

// Decode without verification (inspect expired/untrusted tokens):
const unsafeClaims = decodeUnsafe(token);
```

`encodeAccessToken` and `encodeRefreshToken` add a `typ` claim (`access` or `refresh`).

## RBAC

```js
import { createRBAC } from "@oneunit/auth";

const rbac = createRBAC({
  roles: {
    support: { permissions: ["ticket.read", "ticket.reply"] },
    lead: { inherits: "support", permissions: ["ticket.assign"] },
  },
});

rbac.grant("lead", "ticket.close");
rbac.can({ roles: ["lead"] }, "ticket.reply");
rbac.authorize({ roles: ["support"] }, "ticket.read");
```

`defineRoles` is a typed helper for declaring role definitions outside the constructor:

```js
import { defineRoles, createRBAC } from "@oneunit/auth";

const roles = defineRoles({
  viewer: { permissions: ["doc.read"] },
  editor: { inherits: "viewer", permissions: ["doc.write"] },
});

const rbac = createRBAC({ roles });
```

Use `matchPermission` directly to test a single granted permission against a required one:

```js
import { matchPermission } from "@oneunit/auth";

matchPermission("invoice.*", "invoice.read");  // true
matchPermission("invoice.*", "invoice.read.all"); // false
matchPermission("invoice.**", "invoice.read.all"); // true
```

Permission wildcards:

| Granted | Matches | Does not match |
| :--- | :--- | :--- |
| `*` | anything | — |
| `invoice.*` | `invoice.read` | `invoice.read.all`, `invoices.read` |
| `invoice.**` | `invoice.read`, `invoice.read.all` | `payment.read` |

`*` stays within one dot-separated segment. `**` spans any number of segments.

Direct permissions on a user still work:

```js
rbac.can({ roles: ["member"], permissions: ["beta.access"] }, "beta.access");
```

These are evaluated against a subject you construct in code. A `permissions`
array on a stored user record is not copied into access tokens — see
[Access token claims](#access-token-claims).

> **`defaultRole` is a grant to anonymous callers.** A subject with no roles —
> including `null` and `undefined` — is assigned `defaultRole`, so
> `can(null, "post.write")` is `true` if `defaultRole` carries that permission.
> Keep `defaultRole` unprivileged, and check for a subject before asking:
>
> ```js
> if (ctx.state.user && auth.can(ctx.state.user, "post.write")) { ... }
> ```
>
> The bundled adapters check for a missing user before calling `can`.

## Passwords

```js
import { hashPassword, verifyPassword, needsRehash } from "@oneunit/auth";

const passwordHash = await hashPassword("correct horse battery staple");
await verifyPassword("correct horse battery staple", passwordHash);

// Check if a stored hash needs upgrading (e.g. cost parameter changed):
if (needsRehash(passwordHash, { cost: 32768 })) {
  const newHash = await hashPassword(password, { cost: 32768 });
  // persist newHash
}
```

With a user store, `auth.register()` and `auth.loginWithPassword()` hash and verify for you.

Cost parameters travel inside the hash so they can be raised later, and they are
range-checked before any work happens — a hash carrying hostile parameters
returns `false` rather than being computed. See
[ARCHITECTURE.md](./docs/ARCHITECTURE.md#stored-parameters-are-treated-as-hostile-input)
for the bounds and why they are needed.

```js
const auth = createAuth({
  secret: process.env.AUTH_SECRET,
  userStore: {
    async findByCredentials(identifier) {},
    async create(input) {},
    async updatePassword(id, passwordHash) {},
  },
});

await auth.register({ email: "ada@example.com", password: "s3cret-pass" });
await auth.loginWithPassword("ada@example.com", "s3cret-pass");
```

`register()` ignores a `roles` field in its first argument so a public sign-up
form cannot self-assign a role. Pass roles as the second, server-side argument.

## Social login

Built-in providers: `google`, `github`, `instagram`, `facebook`, `twitter` (X), `discord`, `apple`, `linkedin`, `microsoft`, `reddit`, `twitch`, `slack`, `spotify`, `tiktok`.

```js
const auth = createAuth({
  secret: process.env.AUTH_SECRET,
  providers: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      redirectUri: "http://localhost:3000/auth/google/callback",
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      redirectUri: "http://localhost:3000/auth/github/callback",
    },
    instagram: {
      clientId: process.env.INSTAGRAM_CLIENT_ID,
      clientSecret: process.env.INSTAGRAM_CLIENT_SECRET,
      redirectUri: "http://localhost:3000/auth/instagram/callback",
    },
  },
});

const { url, state } = await auth.getAuthorizationUrl("google");

const session = await auth.loginWithOAuth("google", {
  code: req.query.code,
  state: req.query.state,
});
```

The callback params also accept a string: a full URL, a path with a query, a
leading `?code=...`, or a bare `"code=...&state=..."`.

### PKCE

Public clients should set `pkce: true`. The package generates and stores the
verifier for you. To manage it yourself, use the exported helpers:

```js
import { pkceVerifier, pkceChallenge } from "@oneunit/auth";

const verifier = pkceVerifier();
const challenge = pkceChallenge(verifier); // S256, base64url
```

### Provider user store

Optional user-store methods for linking accounts:

- `findByProvider(provider, providerId)`
- `findByEmail(email)`
- `createFromProvider(provider, profile, tokens)`
- `linkProvider(userId, provider, profile)`

If no store is configured, login still works and uses a synthetic id such as
`google:123`. That id is built from the provider profile's `id`, so
`profileMap` must map a stable identifier — a profile without one throws
`ProviderError` rather than collapsing every user of that provider onto the
same subject.

### Custom providers

```js
import { createProvider, createOAuth } from "@oneunit/auth";

const acme = createProvider({
  id: "acme",
  authorizationUrl: "https://acme.example/oauth/authorize",
  tokenUrl: "https://acme.example/oauth/token",
  userInfoUrl: "https://acme.example/me",
  scopes: ["profile"],
  profileMap: { id: "id", email: "email", name: "name" },
});

const oauth = createOAuth();
oauth.use("acme", { provider: acme, clientId: "...", clientSecret: "..." });
```

List all built-in provider definitions:

```js
import { builtinProviders, getProvider } from "@oneunit/auth";

console.log(Object.keys(builtinProviders)); // ["google", "github", ...]
const gh = getProvider("github");
```

## Framework adapters

The adapters never import a web framework. They read the request and response
objects you pass them structurally, so `@oneunit/auth` has no peer dependencies
at all and works whether or not Express, Fastify, Koa, or uWebSockets.js is
installed. Install your framework as usual alongside this package.

This also means the adapters are not tied to a framework's major version: they
depend on a small shape (`headers`, `cookies`, `query`, a `send`-style reply)
rather than on a class.

### Express

```js
import { createAuth, expressAdapter } from "@oneunit/auth";

const auth = createAuth({ secret: process.env.AUTH_SECRET });
const { authenticate, requirePermission, requireRole } = expressAdapter(auth);

app.get("/me", authenticate(), (req, res) => res.json(req.user));
app.get("/admin", authenticate(), requireRole("admin"), handler);
app.get("/reports", authenticate(), requirePermission("report.read"), handler);
```

### Fastify

```js
import { createAuth, fastifyAdapter } from "@oneunit/auth";

await fastify.register(fastifyAdapter(auth));
fastify.get("/me", { preHandler: [fastify.authenticate()] }, async (req) => req.user);
```

### Koa

```js
import { createAuth, koaAdapter } from "@oneunit/auth";

const { authenticate, requirePermission } = koaAdapter(auth);
app.use(authenticate());
```

### uWebSockets.js

uWS request/response objects are invalid after the first `await`. The adapter snapshots headers and query first.

```js
import uWS from "uWebSockets.js";
import { createAuth, uwsAdapter } from "@oneunit/auth";

const auth = createAuth({ secret: process.env.AUTH_SECRET });
const { authenticate, requirePermission, json } = uwsAdapter(auth);

uWS.App()
  .get("/me", authenticate()((res, _req, request) => {
    json(res, 200, { user: request.user });
  }))
  .get("/stats", authenticate()(requirePermission("stats.read")((res, _req, request) => {
    json(res, 200, { ok: true, userId: request.user.userId });
  })))
  .listen(3000, (token) => {
    if (!token) throw new Error("listen failed");
  });
```

Use `snapshotUwsRequest` directly if you need the raw snapshot outside the adapter:

```js
import { snapshotUwsRequest } from "@oneunit/auth";

const snapshot = snapshotUwsRequest(res, req);
// snapshot.headers, snapshot.query, snapshot.url are safe to use after await
```

### Generic / createAdapters

`createAdapters` generates all four adapter sets at once:

```js
import { createAuth, createAdapters } from "@oneunit/auth";

const auth = createAuth({ secret: process.env.AUTH_SECRET });
const { express, fastify, koa, uws } = createAdapters(auth);
```

### Standalone HTTP

```js
const claims = await auth.verifyRequest(req);
```

Tokens are read from `Authorization: Bearer` or an `access_token` cookie.

The query string is **not** read by default. A token in a URL ends up in access
logs, proxy logs, browser history, and the `Referer` header sent to third
parties. Opt in per call for flows that cannot set a header, such as an
`EventSource` or a file download:

```js
await auth.verifyRequest(req, { query: true });
```

You can also extract the bearer token yourself:

```js
import { extractBearerToken } from "@oneunit/auth";

const token = extractBearerToken(req);
```

## Refresh tokens

```js
const session = await auth.login(user);
const next = await auth.refresh(session.refreshToken);
await auth.logout(next.refreshToken);
```

Refresh tokens rotate on every use: `auth.refresh()` invalidates the token it
consumes. A refresh token is never accepted by `verify()` or `verifyRequest()`,
so it cannot be replayed as an access credential.

### In-memory refresh store

For development and testing, use the built-in memory store:

```js
import { createAuth, createMemoryRefreshStore } from "@oneunit/auth";

const auth = createAuth({
  secret: process.env.AUTH_SECRET,
  refreshStore: createMemoryRefreshStore(),
});
```

### Custom refresh store

Persist tokens with a custom `refreshStore`:

| Method | Required | Purpose |
| --- | --- | --- |
| `save(record)` | yes | Store a newly issued refresh token |
| `get(id)` | yes | Look up a record |
| `consume(id)` | recommended | Atomically look up **and** remove a record |
| `revoke(id)` | required unless `consume` exists | Invalidate a record on logout |

Implement `consume` whenever you can. `get` followed by `revoke` is two
round-trips, so two concurrent requests presenting the same token can both
pass the validity check and each receive a new session. `consume` must be a
single atomic operation (`GETDEL` in Redis, a `DELETE ... RETURNING` in SQL).

`revoke` and `consume` are not optional in practice: if neither exists,
`auth.refresh()` and `auth.logout()` throw `ConfigurationError` rather than
report a logout that never happened. A store implementing only `consume()` is
enough for both rotation and logout.

## Sessions and revocation

`auth.logout()` revokes one refresh token. It cannot un-sign an access token
that was already issued — that token stays valid until it expires, and its
`roles` and `permissions` are a snapshot from login. So a role change is not
retroactive either.

To invalidate a session immediately, everywhere, configure a `sessionStore`.
Tokens then carry a session version and (for session stores that can answer the
check) a session id that is checked on every `verify()` and `refresh()`:

```js
const auth = createAuth({
  secret,
  sessionStore: createMemorySessionStore(), // or your shared store
});

await auth.revokeAllSessions(userId); // every device, access and refresh
await auth.revokeSession(sessionId);  // one session only
```

`revokeAllSessions()` bumps the user-wide version. `revokeSession()` marks the
session id carried in the token (`sid`) as revoked without touching other
sessions for the same user. Stateless JWT verification remains unchanged: when
no `sessionStore` is configured, no per-verification store read happens and
`revokeAllSessions()` returns `false` instead of claiming success.

This costs one store read per verification, which is why it is opt-in. Without
a `sessionStore`, `revokeAllSessions()` returns `false` rather than appearing
to succeed. If you would rather stay stateless, set a short `accessTokenTtl` and
accept the window instead.

### Custom session store

| Method | Required | Purpose |
| --- | --- | --- |
| `getVersion(userId)` | yes | Current version for a user; `undefined` counts as `0` |
| `bumpVersion(userId)` | for `revokeAllSessions` | Invalidate every session for a user |
| `revokeSession(jti)` | for `revokeSession` | Invalidate one session by its jti |
| `isSessionRevoked(jti)` | recommended | Answer whether a session id has been revoked |

### Optional Redis adapter

When you need shared state across application instances, install the optional
adapter and use its Redis-backed stores:

```js
import Redis from "ioredis";
import { createRedisStores } from "@oneunit/redis/auth";

const redis = new Redis(process.env.REDIS_URL);
const stores = createRedisStores(redis);

const auth = createAuth({
  secret,
  refreshStore: stores.refreshStore,
  sessionStore: stores.sessionStore,
});
```

In-memory stores remain process-local and are not suitable for shared
production deployments.

### Access token claims

Permissions in an access token are derived from RBAC roles. A `permissions`
array on the user record is ignored unless you opt in:

```js
const auth = createAuth({ secret, trustUserPermissions: true });
```

Roles assigned during registration come from the server-side options argument,
never the request body:

```js
await auth.register({ email, password }, { roles: ["member"] });
```

### Reserved claims

`sub`, `userId`, `roles`, `permissions`, `typ`, `iss`, `aud`, `exp`, `iat`,
`nbf`, `jti`, and `sv` are derived from the authenticated user and RBAC, and
cannot be replaced by a claim extractor or by `additionalClaims`. Doing so
throws rather than silently minting a token for someone else:

```js
auth.registerExtractor("sub", fn);                            // throws
auth.login(user, { additionalClaims: { roles: ["admin"] } }); // throws
```

Any other name is yours — `name`, `email`, `tier`, `tenantId`, and so on.

## Utilities

```js
import {
  isValidExpiresIn,
  parseExpiresIn,
  randomToken,
  randomState,
} from "@oneunit/auth";

isValidExpiresIn("15m"); // true
isValidExpiresIn("1y");  // false — ambiguous unit

parseExpiresIn("7d"); // 604800 (seconds)

const token = randomToken(); // cryptographically random hex string
const state = randomState(); // for OAuth state parameter
```

### OAuth state store

For development, `createMemoryStateStore()` keeps OAuth state in memory:

```js
import { createMemoryStateStore } from "@oneunit/auth";
```

## Errors

All errors extend `AuthError` and include `code` and `status`:

| Class | Code | Status |
| --- | --- | --- |
| `InvalidTokenError` | `INVALID_TOKEN` | 401 |
| `TokenExpiredError` | `TOKEN_EXPIRED` | 401 |
| `UnauthorizedError` | `UNAUTHORIZED` | 401 |
| `ForbiddenError` | `FORBIDDEN` | 403 |
| `ConfigurationError` | `CONFIGURATION_ERROR` | 500 |
| `OAuthError` | `OAUTH_ERROR` | 401 |
| `ProviderError` | `PROVIDER_ERROR` | 502 |
| `ValidationError` | `VALIDATION_ERROR` | 400 |

## API reference

Every named export from `@oneunit/auth`:

### Core

| Export | Kind | Description |
| :--- | :--- | :--- |
| `createAuth` | function | Create an `Auth` instance with JWT, RBAC, OAuth, and password support |
| `Auth` | class | The auth instance class |
| `auth` | function | Alias for `createAuth` |

### JWT

| Export | Kind | Description |
| :--- | :--- | :--- |
| `encode` | function | Sign a JWT payload |
| `decode` | function | Verify and decode a JWT |
| `decodeUnsafe` | function | Decode a JWT without verification |
| `encodeAccessToken` | function | Sign a JWT with `typ: "access"` |
| `encodeRefreshToken` | function | Sign a JWT with `typ: "refresh"` |

### RBAC

| Export | Kind | Description |
| :--- | :--- | :--- |
| `createRBAC` | function | Create an RBAC instance |
| `RBAC` | class | The RBAC class |
| `defineRoles` | function | Typed helper for role definitions |
| `matchPermission` | function | Test a granted permission against a required one |

### Passwords

| Export | Kind | Description |
| :--- | :--- | :--- |
| `hashPassword` | function | Hash a password with scrypt |
| `verifyPassword` | function | Verify a password against a hash |
| `needsRehash` | function | Check if a hash needs upgrading |

### OAuth

| Export | Kind | Description |
| :--- | :--- | :--- |
| `createOAuth` | function | Create a standalone OAuth manager |
| `OAuth` | class | The OAuth class |
| `createProvider` | function | Define a custom OAuth provider |
| `getProvider` | function | Look up a built-in provider by name |
| `builtinProviders` | object | Map of all built-in provider definitions |
| `pkceVerifier` | function | Generate a PKCE code verifier |
| `pkceChallenge` | function | Compute S256 PKCE challenge |
| `createMemoryStateStore` | function | In-memory OAuth state store |

### Built-in providers

`google`, `github`, `instagram`, `facebook`, `twitter`, `discord`, `apple`, `linkedin`, `microsoft`, `reddit`, `twitch`, `slack`, `spotify`, `tiktok` — each exported as a provider definition object.

### Framework adapters

| Export | Kind | Description |
| :--- | :--- | :--- |
| `expressAdapter` | function | Express middleware factory |
| `fastifyAdapter` | function | Fastify plugin factory |
| `koaAdapter` | function | Koa middleware factory |
| `uwsAdapter` | function | uWebSockets.js adapter factory |
| `snapshotUwsRequest` | function | Snapshot a uWS request for use after `await` |
| `createAdapters` | function | Create all four adapters at once |

### Stores

| Export | Kind | Description |
| :--- | :--- | :--- |
| `createMemoryRefreshStore` | function | In-memory refresh token store (dev/test) |

### Utilities

| Export | Kind | Description |
| :--- | :--- | :--- |
| `parseExpiresIn` | function | Parse a TTL string to seconds |
| `isValidExpiresIn` | function | Validate a TTL string or number |
| `randomToken` | function | Cryptographically random hex token |
| `randomState` | function | Random string for OAuth state |
| `extractBearerToken` | function | Extract a bearer token from a request |

### Errors

`AuthError`, `InvalidTokenError`, `TokenExpiredError`, `UnauthorizedError`, `ForbiddenError`, `ConfigurationError`, `OAuthError`, `ProviderError`, `ValidationError`.

### Types

`AuthErrorOptions`, `JwtSignOptions`, `JwtVerifyOptions`, `JwtPayload`, `Secret`, `RoleDefinition`, `RBACOptions`, `AuthSubject`, `PasswordOptions`, `OAuthProfile`, `OAuthTokens`, `OAuthProviderConfig`, `OAuthProvider`, `ProviderDefinition`, `StateStore`, `OAuthOptions`, `OAuthAuthorizeOptions`, `UserRecord`, `UserStore`, `RefreshRecord`, `RefreshStore`, `LoginOptions`, `LoginResult`, `SessionStore`, `AuthOptions`, `AuthHookName`, `AuthHookHandler`, `RequestLike`, `ExtractTokenOptions`, `UwsHttpResponse`, `UwsHttpRequest`, `UwsRequestSnapshot`, `UwsHandler`, `ExpressRequestLike`, `ExpressResponseLike`, `ExpressNext`, `KoaContextLike`, `FastifyLike`, `FastifyRequestLike`, `FastifyReplyLike`.

## Examples

| File | Shows |
| :--- | :--- |
| `examples/basic.ts` | Login, verification, RBAC, password hashing, refresh rotation and replay rejection |

Run it:

```bash
npm run example
```

From an installed copy:

```bash
npx tsx node_modules/@oneunit/auth/examples/basic.ts
```

## Scripts

```bash
npm test
npm run typecheck
npm run build
npm run pack:check
```

CI runs typecheck, tests, build, `pack:check`, and `pnpm audit` on Node 20, 22,
and 24, then installs the packed tarball into a clean project and exercises the
public API and the shipped examples against it.

## License

[MIT]. Copyright (c) 2026 mayank.
