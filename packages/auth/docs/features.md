# `@oneunit/auth` Feature Reference

This document describes the capabilities that are implemented in the current
package. It is intentionally code-oriented: names match exports in
`src/index.ts`, and statements are paired with the implementation that backs
them.

## Package shape

- One runtime dependency: `jsonwebtoken`.
- No framework peer dependencies. Adapters are structural and do not import
  Express, Fastify, Koa, or uWebSockets.js.
- Node.js 20+.
- Public entry point is `src/index.ts`; folder `index.ts` files are the only
  folder entry points.
- Side-effect-free import, with explicit construction through `createAuth`, `createRBAC`,
  `createOAuth`, and `createProvider`.

## Optional Redis storage adapter

`@oneunit/redis/auth` provides Redis-backed `RefreshStore`, `SessionStore`,
and `StateStore` implementations without adding Redis dependencies to the core
package. Store contracts remain implemented through dependency injection.

## Authentication core (`createAuth`)

`createAuth(options)` builds a single `Auth` facade. Security-sensitive values are
validated at construction time, including the required JWT secret.

Core capabilities:

- Issue access and refresh tokens.
- Verify tokens with algorithm pinning and claim checks.
- Extract bearer tokens from headers, cookies, and (opt-in) query strings.
- Refresh rotation with reuse detection.
- Password registration and login with a user store.
- OAuth 2.0 / OIDC code flow integration.
- Generic RBAC checks through a configured RBAC instance.
- Session revocation through an optional session store.
- Hooks (`beforeLogin`, `afterLogin`, `afterVerify`) and custom claim extractors.
- Reserved-claim protection so request or profile data cannot overwrite identity,
  roles, permissions, or token type.

`Auth` never depends on a web framework or persistence implementation. Stores and
adapters are supplied by the caller.

## JWT services

Functions in `src/crypto/jwt.ts` and exposed through `src/index.ts`:

- `encode` signs a payload with HS256 by default and supports `expiresIn`,
  `subject`, `issuer`, `audience`, `algorithm`, `jwtid`, and clock options.
- `decode` verifies signature, issuer, audience, algorithm, expiration, and
  returns claims only after successful verification.
- `decodeUnsafe` decodes without verification for inspection only.
- `encodeAccessToken` signs with `typ: "access"`.
- `encodeRefreshToken` signs with `typ: "refresh"`.

Safety properties:

- Algorithm confusion is prevented by pinning the algorithm list for JWT access tokens.
- Missing secrets and invalid configuration fail early.
- Refresh tokens carry `jti` and cannot be used as access tokens.
- Claim extractors cannot introduce reserved claims (`sub`, `userId`, `roles`,
  `permissions`, `typ`, `iss`, `aud`, `exp`, `iat`, `nbf`, `jti`, `sv`, `sid`).
- Additional claims cannot override reserved claims.

## RBAC

`src/rbac/index.ts` implements a generic role and permission model:

- Roles declare permissions and optional inheritance.
- Permission wildcards:
  - `*` matches one dot-separated segment boundary according to README’s
    documented table.
  - `**` spans any number of segments.
- `createRBAC` constructs an instance from a role definition.
- `defineRoles` provides a typed helper for declarations.
- `matchPermission` tests one granted permission against one required permission.
- `can` evaluates a subject against a permission.
- `cannot` is the negation of `can`.
- `authorize` throws `ForbiddenError` on denial.
- `hasAnyRole` checks whether a subject holds any of the given roles.
- `hasAllRoles` checks whether a subject holds all of the given roles.
- `snapshot` returns a plain-object view of current roles, permissions, and inheritance.

Roles are application-defined. The package ships no hard-coded product roles.
An unprivileged `defaultRole` is deliberately allowed and is assigned to
subjects without `roles`/`role` fields (such as `{}`), but never to `null`,
`undefined`, or `""`.

## Passwords

`src/crypto/password.ts`:

- `hashPassword` hashes with scrypt using serialized cost parameters.
- `verifyPassword` verifies against stored parameters and returns `false` for
  outside bounds.
- `needsRehash` indicates whether a stored hash should be upgraded.
- Cost parameters are bounded defensively before hashing to prevent
  attacker-controlled hashes from forcing excessive work.

`Auth` integrates password hashing through `loginWithPassword`, `register`, and
password extractors.

## OAuth 2.0 and OIDC

### Core flow

`src/oauth/index.ts` implements:

- State generation and storage with optional TTL.
- Authorization URL generation.
- Code exchange.
- Profile fetching.
- Automatic PKCE generation when configured.
- Provider lookup through `builtinProviders` and `getProvider`.
- Custom providers through `createProvider`.

### PKCE

`src/oauth/providers/index.ts` exports:

- `pkceVerifier`: 32-byte base64url verifier.
- `pkceChallenge`: S256 (SHA-256, base64url) challenge.

PKCE is enabled per provider or per config. The verifier is generated unless the
caller supplies one and is preserved through the state store for callback
validation.

### Built-in providers

Fourteen built-in providers are defined: Google, GitHub, Instagram, Facebook,
X/Twitter, Discord, Apple, LinkedIn, Microsoft, Reddit, Twitch, Slack, Spotify,
and TikTok. Each provider declares authorization and token URLs, scopes, profile
mapping, and optional profile parsing logic.

### Custom providers

`createProvider(definition)` allows a custom OAuth provider with:

- Required `id`, `authorizationUrl`, and `tokenUrl`.
- Scopes.
- Profile mapping or custom `parseProfile`.
- PKCE and token authentication method settings.
- Extra authorization and token parameters.
- User info headers.

### Provider user linking

`Auth.loginWithOAuth` supports optional user-store methods:

- `findByProvider`
- `findByEmail`
- `createFromProvider`
- `linkProvider`

If no store is configured, it creates a synthetic subject such as
`google:123`. Profile subject IDs must be stable and non-empty; otherwise
`ProviderError` is thrown rather than collapsing users.

### OIDC ID-token verification

For Google and Apple, ID tokens are verified against JWKS:

- `alg` must be `RS256`.
- `kid` is required.
- The matching public key must be present after allowed refresh.
- Signature verification uses Node `crypto`.
- Issuer, audience, expiration, and nonce are checked after signature
  verification.
- Unsupported algorithms, malformed segments, and missing claims are rejected.
- JWKS is cached by URL with configurable TTL (`jwksCacheTtlMs`).
- An unknown `kid` triggers one forced JWKS refetch before rejection.
- Cached or inline `jwks` inputs are respected according to their type.

The Google verifier validates against Google’s official issuer and JWKS. A JWKS
refresh occurs only for unknown key IDs and does not bypass signature
verification.

### Apple-specific behavior

Apple profile data comes from the token itself, so its `id_token` is verified
before profile extraction.

## Refresh tokens and session revocation

### Refresh rotation

`auth.refresh()`:

- Decodes and verifies the refresh token.
- Rejects non-refresh tokens.
- Requires `jti`.
- Consumes the record atomically when `consume` exists, otherwise performs
  get-plus-revoke.
- Rejects consumed or revoked tokens.
- Checks session version before a new access token is issued.
- Mints a new access/refresh session through `login`.

This makes replay of a consumed refresh token fail.

### Logout

`auth.logout()` and `auth.revoke()` remove a refresh record. They cannot
invalidate already-issued access tokens, which remain valid until expiry.

### Session stores

Configuring `sessionStore` enables immediate session invalidation:

- Tokens carry `sv`, the session version at login.
- `verify()` and `refresh()` compare `sv` against the current version.
- `revokeAllSessions(userId)` bumps the version and invalidates all current
  tokens for that user.
- Without a store, `revokeAllSessions()` returns `false`.

This is opt-in because it adds one store read per verification.

## Framework adapters

`src/adapters` provides structural adapters for:

- Express: `expressAdapter(auth)` returns `authenticate`, `requirePermission`,
  and `requireRole`.
- Fastify: `fastifyAdapter(auth)` registers a plugin and exposes
  `authenticate`.
- Koa: `koaAdapter(auth)` returns middleware.
- uWebSockets.js: `uwsAdapter(auth)` returns handler factories and `json`.
- `createAdapters(auth)` constructs all adapters at once.

Adapter properties:

- No web framework imports or peer dependencies.
- Request/response objects are read structurally.
- Adapted permissions and roles return 401 or 403 as appropriate.
- uWS request data is snapshotted before async work through
  `snapshotUwsRequest`, because native uWS objects are unsafe afterward.
- Query-token extraction is opt-in via `{ query: true }`, avoiding tokens in
  logs, history, and referrers by default.
- Direct `verifyRequest` and `extractBearerToken` are available for custom
  adapters.

## Password hashing

The scrypt implementation enforces bounded cost parameters and serializes them
into the resulting hash. Hashes can be upgraded later, and verification returns
`false` for parameters outside configured/per package bounds.

## Utilities

Exported helpers:

- `isValidExpiresIn`: validates supported TTL expressions.
- `parseExpiresIn`: converts an expression to seconds.
- `randomToken`: cryptographically random hex token.
- `randomState`: random string for OAuth state.
- `extractBearerToken`: extracts a bearer token from a request structure.
- `pkceVerifier` and `pkceChallenge`.
- `createMemoryRefreshStore`, `createMemorySessionStore`, `createMemoryStateStore`.

## Errors

All auth errors extend `AuthError` and expose `code` and `status`:

- `InvalidTokenError`: `INVALID_TOKEN`, 401
- `TokenExpiredError`: `TOKEN_EXPIRED`, 401
- `UnauthorizedError`: `UNAUTHORIZED`, 401
- `ForbiddenError`: `FORBIDDEN`, 403
- `ConfigurationError`: `CONFIGURATION_ERROR`, 500
- `OAuthError`: `OAUTH_ERROR`, 401
- `ProviderError`: `PROVIDER_ERROR`, 502
- `ValidationError`: `VALIDATION_ERROR`, 400

## Built-in middleware and request parsing

- Adapters authenticate from `Authorization: Bearer` or an `access_token`
  cookie by default.
- Optional and query modes are documented in README.
- Extractors for headers, cookies, and query are framework-agnostic.

## Live Google verification tools

The package includes two scripts:

- `scripts/verify-google-id-token.ts`: performs the full OAuth callback flow,
  exchanges the authorization code, and validates the returned Google ID token.
- `scripts/watch-google-jwks.mjs`: monitors Google’s discovery/JWKS endpoints,
  records immutable snapshots and event logs, detects key additions/removals
  and public-key changes, preserves state across restarts, and supports
  optional JWT header inspection without printing the token.

These tools do not force Google rotation and never print client secrets or full
ID tokens.

## Test and verification surface

- Deterministic tests in `test/*.test.ts` cover JWT, passwords, RBAC, OAuth,
  OIDC/JWKS rotation scenarios, adapters, sessions, and architecture/API exports.
- `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` are the
  core quality gates.
- Optional Redis/PostgreSQL tests validate refresh atomicity.
- Opt-in live Google tests and documentation are maintained but not required
  for release.

## Limitations

- Live Google signing-key rotation is not claimed as verified unless an actual
  previously uncached key is observed and successfully validated.
- In-memory stores are development-only and are not suitable for multi-instance
  production deployments.
- Removing or revoking a session does not invalidate already-issued access
  tokens before expiry.
- Provider rotation handling is bounded by one JWKS refresh per verification.
