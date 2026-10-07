# @oneunit/auth

Framework-agnostic TypeScript authentication for Node.js. JWT, generic RBAC, scrypt passwords, and social OAuth.

Works standalone or with Express, Fastify, Koa, or uWebSockets.js.

Package README: `packages/auth/README.md`
Package architecture: `packages/auth/ARCHITECTURE.md`

## Install

```bash
npm install @oneunit/auth
```

## Quick start

```javascript
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
      admin: { inherits: "member", permissions: ["user.manage"] },
    },
  },
});

const { accessToken, refreshToken, payload } = await auth.login({
  id: 42,
  email: "ada@example.com",
  roles: ["member"],
});
```

`secret` is required.

`auth.login()` signs whatever user record you hand it and performs no
authorization. Resolve the user through `loginWithPassword()` or your own store
first, and never pass a request body straight into it — a caller who can set
`roles` can grant themselves any role in your RBAC config.

## Refresh tokens

Access and refresh tokens are both JWTs signed with the same key by default and
distinguished by a `typ` claim. `auth.verify()` rejects a refresh token, so it
cannot be used as a bearer credential, and `auth.refresh()` rotates on every
call: the presented token is consumed and cannot be reused.

```javascript
const next = await auth.refresh(refreshToken);
await auth.logout(next.refreshToken);
```

Persist refresh tokens with a custom `refreshStore` and implement `consume()` as
a single atomic operation (`GETDEL`, `DELETE ... RETURNING`,
`findOneAndDelete`). Two concurrent requests carrying the same token will both
succeed with a `get()` + `revoke()` implementation. A store that can neither
`consume` nor `revoke` makes `refresh()` and `logout()` throw
`ConfigurationError` rather than silently do nothing.

## Roles and permissions

Permissions in an access token are derived from your RBAC roles. Two things are
deliberately ignored:

- A `roles` field in `auth.register()`'s input argument. Pass roles through the
  second, server-side argument instead.
- A `permissions` array on the user record. Set `trustUserPermissions: true`
  only if a separate write path guarantees the column is server-controlled.

```javascript
await auth.register({ email, password }, { roles: ["member"] });
```

## Fastify adapter

```javascript
import { createAuth, fastifyAdapter } from "@oneunit/auth";

await fastify.register(fastifyAdapter(auth));
fastify.get("/me", { preHandler: [fastify.authenticate()] }, async (req) => req.user);
fastify.get("/admin", { preHandler: [fastify.authenticate(), fastify.requireRole("admin")] }, handler);
```

Tokens are read from `Authorization: Bearer` or an `access_token` cookie. The
query string is only read when you pass `{ query: true }`, which you need for
flows that cannot set a header — a browser `WebSocket`, an `EventSource`, or a
file download. `optional: true` set on the plugin applies to every route
unless a route passes its own options.

## Also included

- `encode` / `decode` JWT helpers
- `createRBAC`, permission wildcards (`*`, `invoice.*`, `audit.**`)
- `hashPassword` / `verifyPassword` (scrypt)
- `auth.register` / `auth.loginWithPassword` with a `userStore`
- Built-in OAuth providers (Google, GitHub, and others)
- `expressAdapter`, `koaAdapter`, `uwsAdapter`

See `docs/security.md` for production token and password guidance and
`packages/auth/CHANGELOG.md` for the 2.0.0 migration notes.
