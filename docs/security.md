# Security

This guide covers how the packages handle authentication, secrets, transport security, logging, and HTTP hardening. It is defensive configuration guidance for applications built on this framework.

Repository: https://github.com/mayank040902/framework

## Threat model (application)

Assume:

- The Node.js process is trusted
- PostgreSQL, Redis, and Kafka are on a private network or TLS-protected
- Clients are untrusted
- Logs may be shipped to a third-party aggregator

Do not put long-lived secrets in JWTs, logs, query strings, or Kafka payloads.

## Secrets and configuration

| Secret | Variable | Used by |
| :--- | :--- | :--- |
| JWT signing key | `AUTH_SECRET` | auth |
| JWT refresh key | `AUTH_REFRESH_SECRET` | auth (falls back to `AUTH_SECRET`) |
| Postgres password | `DATABASE_URL` / `DATABASE_PASSWORD` | database |
| Redis password | `REDIS_URL` | redis |
| Kafka SASL password | `KAFKA_SASL_PASSWORD` | kafka |
| Cookie signing secret | `COOKIE_SECRET` | `@fastify/cookie` |
| OAuth client secrets | `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`, ... | auth providers |

Rules:

- Never commit `.env` files. The root `.gitignore` ignores `.env` and `.env.*` except `.env.example`.
- Use a distinct `AUTH_SECRET` per environment. Do not use `"change-me"` in production.
- Prefer connection URLs that already include TLS query flags (`sslmode=require`).
- Database credentials are never written to logs by `@oneunit/database`.

`createAuth` throws `ConfigurationError` if `secret` is missing. That is intentional.

## Authentication

`@oneunit/auth` issues JWT access and refresh tokens via `jsonwebtoken`.

- Default algorithm: **HS256**
- Default access TTL: **15m**
- Default refresh TTL: **7d**
- Access tokens include `typ: "access"`; refresh tokens include `typ: "refresh"`
- Tokens are read from `Authorization: Bearer` or an `access_token` cookie. The
  query string is **not** read unless you pass `{ query: true }`

### Token type separation

Access and refresh tokens are signed with the same key unless you set
`refreshSecret`. `auth.verify()` rejects any token whose `typ` is `refresh`, so a
long-lived refresh token cannot be replayed as a bearer credential. Do not
re-enable this with `acceptTokenType: "refresh"` on a public route.

### Refresh rotation

`auth.refresh()` consumes the token it is given, so a stolen refresh token is
usable at most once. Persist tokens through `refreshStore` and implement
`consume()` as a single atomic operation:

| Store | Atomic primitive |
| :--- | :--- |
| Redis | `GETDEL key` |
| PostgreSQL | `DELETE FROM sessions WHERE id = $1 RETURNING *` |
| MongoDB | `findOneAndDelete({ _id })` |

A `get()` followed by `revoke()` is two round-trips, so two concurrent requests
carrying the same token can both pass the validity check and each receive a new
session. A store implementing neither `consume` nor `revoke` makes `refresh()`
and `logout()` throw `ConfigurationError` rather than report a logout that never
happened.

### Authorization inputs

`@oneunit/auth` treats roles and permissions as privileged inputs:

- `auth.register()` ignores a `roles` field in its input argument. A public
  sign-up form posts directly into that argument. Pass roles through the second,
  server-side argument: `auth.register(input, { roles: ["member"] })`.
- Access token permissions are derived from RBAC roles. A `permissions` array on
  the user record is not copied into the token, so a compromised or
  attacker-writable column cannot mint arbitrary grants. `trustUserPermissions:
  true` opts back in — only if a separate write path guarantees the column is
  server-controlled.
- `auth.login()` is a low-level primitive. It signs whatever user record it is
  given and performs no authorization. Resolve the user through
  `loginWithPassword()` or your own store first; never forward a request body
  into it.

Production recommendations:

1. Set `issuer` and `audience` and verify them
2. Keep access tokens short-lived
3. Persist refresh tokens in Redis or Postgres via `refreshStore` with an atomic
   `consume()` so logout and rotation work
4. Do not put passwords, tokens, or PII beyond user id/roles in JWT claims
5. Prefer header or cookie tokens. Query-string tokens are opt-in (`{ query:
   true }`) precisely because a token in a URL lands in access logs, proxy
   logs, browser history, and the `Referer` header sent to third parties
6. Treat a TTL as seconds or a `s`/`m`/`h`/`d`/`w` timespan. Anything else throws
   `ValidationError` rather than defaulting, so a token's real expiry can never
   diverge from a locally computed one

### Passwords

`hashPassword` / `verifyPassword` use Node.js `scrypt` with:

- 16-byte random salt
- key length 64
- cost `N=16384`, `r=8`, `p=1`
- `timingSafeEqual` on verify

Hashes are stored as `scrypt$N$r$p$keyLength$salt$hash`. Empty passwords are rejected with `ValidationError`.

### RBAC

There are no built-in product roles. You define roles and permissions.

- `*` matches every permission
- `invoice.*` matches `invoice.read`
- `requirePermission` / `requireRole` run after `authenticate`
- Direct user permissions still work alongside roles

Grant the minimum permissions. Do not give `*` to default roles.

### OAuth

Built-in providers include Google, GitHub, Instagram, Facebook, X/Twitter, Discord, Apple, LinkedIn, Microsoft, Reddit, Twitch, Slack, Spotify, and TikTok.

- Use HTTPS `redirectUri` in production
- Enable PKCE when the provider supports it
- Store OAuth `state` (memory store is for development only)
- Link accounts with `findByProvider` / `findByEmail` to avoid account takeover by email collision

## HTTP hardening (server)

Default builtin plugins:

| Plugin | Default |
| :--- | :--- |
| Helmet | enabled |
| CORS | `{ origin: true, credentials: true }` |
| Cookies | enabled |
| Compression | enabled |
| Rate limit | `{ max: 1000, timeWindow: "1 minute" }` |

Production:

- Set an explicit CORS origin allowlist, not `origin: true`
- Set a cookie `secret` and `httpOnly`, `secure`, `sameSite: "lax"` or `"strict"`
- Lower rate-limit `max` on auth routes (`/auth/login`, `/auth/register`)
- Keep Helmet on; only disable CSP if a browser app requires it
- Do not disable rate limiting on public endpoints

Example:

```javascript
await startServer({
  cors: { origin: ["https://app.example.com"], credentials: true },
  helmet: true,
  cookie: { secret: process.env.COOKIE_SECRET },
  rateLimit: { max: 200, timeWindow: "1 minute" },
});
```

## Logging and redaction

`createLogger({ mode: "production" })` redacts:

- `req.headers.authorization`
- `req.headers.cookie`
- `res.headers['set-cookie']`
- `*.password`
- `*.token`
- `*.accessToken`
- `*.refreshToken`
- `*.secret`

Censor value: `[REDACTED]`.

Do not log request bodies for login or register. The HTTP logger records method, url, remote address, and status — not Authorization headers when production redaction is on.

The Fastify error handler defaults to `includeStack: false`. Enable stacks only in development.

## Database

- All queries are parameterized (`$1`, `$2`, ...). Do not concatenate user input into SQL.
- Prefer `db.query` / models / query builder over string-built SQL.
- Enable TLS with `DATABASE_SSL=true` and `DATABASE_SSL_CA` when Postgres is remote.
- Set `statement_timeout` / `DATABASE_QUERY_TIMEOUT` to bound expensive queries.
- Pool size defaults to 20. Size it to your Postgres `max_connections`.

## Redis

- Use `rediss://` (TLS) when Redis is remote
- Treat Redis as a store for sessions, cache, and jobs — not a public data plane
- BullMQ defaults: 3 attempts, exponential backoff 1000ms, keep last 100 completed / 1000 failed
- Use a dedicated Redis database or prefix (`queue`) per environment
- Set `maxRetriesPerRequest: null` for BullMQ workers as required by BullMQ

## Kafka

- Enable TLS with `KAFKA_SSL=true` and CA/cert/key paths
- Enable SASL with `KAFKA_SASL_MECHANISM`, `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD`
- Do not put credentials in topic payloads
- Validate and bound payload size before produce
- Isolate consumer groups per service and environment

## Realtime and E2EE

- Authenticate WebSocket upgrades with the `authenticate` hook. With `attachWebSocketAdapter()` the hook runs **before** the handshake, so a refused peer is answered with `401` and never holds an open socket; `@fastify/websocket` owns the handshake itself and the refusal arrives as a `1008` close
- A JWT in the query string is convenient but leaks into proxy and access logs. Prefer a cookie, a first message, or a signed header the reverse proxy forwards
- Namespace channels (`user:${userId}`) and authorize joins with the `authorize` hook; it runs server-side for `connect`, `join`, `send` and `broadcast`
- Set `limits.maxMessageSize` and the adapter's `maxPayload` deliberately. `maxPayload` is enforced by `ws` before a frame is buffered, which is what keeps one client from allocating your memory
- `backpressure.maxBufferedBytes` needs `bufferedAmount`; the browser `WebSocket` API has none, so those clients are dropped by `maxConsecutiveDrops` rather than by bytes
- Always terminate TLS at the reverse proxy or in Node.js, and serve `wss://`. The adapter does not encrypt the connection
- Shut down in order — adapter, then hub, then HTTP server — or `server.close()` waits forever on hijacked upgrade sockets
- `createRealtimeHub({ e2ee: true })` uses libsodium `crypto_box` (X25519 + XSalsa20-Poly1305) and `crypto_sign`. Frames are `{ type: "e2ee", ciphertext }`
- E2EE helpers protect payloads between clients that share keys. They do not replace transport TLS (`wss://`), the server still sees channel names, membership and message sizes, and a malicious server can decrypt anything it encrypted. A member without a registered key is skipped, never downgraded to plaintext
- No broker client ships with the package. Cross-instance propagation is an adapter in your application, and it decides the broker, the credentials and the delivery semantics

## Error responses

Do not return internal SQL, stack traces, or connection strings to clients.

`registerErrorHandler` / the server error plugin:

- Maps `AppError` to `{ error, timestamp, path, requestId }`
- Strips `stack` unless `includeStack: true`
- Treats Fastify validation failures as HTTP 400

Auth adapters return `{ error, message }` with 401 or 403 and do not include token contents.

## Process hardening

- Run Node 20+
- Bind to an internal interface in production (`HOST=127.0.0.1` or a private NIC) behind a reverse proxy
- Enable `gracefulShutdown: true` so in-flight requests drain
- Health checks should not expose versions of libraries with known CVEs if that is a concern for your threat model
- Keep `pnpm audit` / `npm audit` in CI

## Checklist

- [ ] `AUTH_SECRET` is long, random, and unique per environment
- [ ] Refresh tokens are stored and revocable
- [ ] CORS origins are explicit
- [ ] Helmet and rate limits are on
- [ ] Production logger redaction is on (`mode: "production"`)
- [ ] Postgres and Redis use TLS off-network
- [ ] Kafka uses SSL and SASL off-network
- [ ] WebSockets require auth before joining private channels
- [ ] WebSocket upgrades are refused before the handshake where the transport allows it
- [ ] `maxPayload` and `limits.maxMessageSize` are set for the traffic you expect
- [ ] No secrets in git, logs, or JWT claims
