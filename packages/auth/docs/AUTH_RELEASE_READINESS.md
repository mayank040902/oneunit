# @oneunit/auth — Advanced Integration Testing & Release Verification Report

## Executive summary

Overall status: **READY WITH LIMITATIONS**.

Deterministic regression suite passes: 234/234 tests. Lint, TypeScript typecheck, production build, packed-tarball consumer smoke and strict TypeScript compilation, and dependency audit (`0 vulnerabilities`) pass. Google discovery and JWKS retrieval pass against Google's real endpoints. Live Google ID-token validation now passed with `scripts/verify-google-id-token.ts` and a real Google-issued ID token.

## Baseline versus final

- Deterministic tests before: 208 passing.
- Deterministic tests after: 234 passing.
- Lint: PASS.
- Typecheck: PASS.
- Build: PASS.
- Redis/Valkey multi-instance atomicity: PASS (14/14, including real PostgreSQL).
- Packed-tarball consumer verification: PASS.
- Dependency audit: PASS (`npm audit --audit-level high` found 0 vulnerabilities).
- Live Google discovery: PASS.
- Live Google JWKS retrieval: PASS.
- Live Google ID-token validation: PASS.

## Changed files

- `src/oauth/providers/index.ts`: Implemented Google OIDC ID-token validation when an `id_token` is present, with issuer, audience, expiration, nonce, and RS256/JWKS checks.
- `test/oidc-jwks.test.ts`: Fixed typecheck and lint issues.
- `test/distributed.test.ts`: Fixed typecheck issues, required/integration service diagnostics, real Redis/PostgreSQL execution.
- `test/oidc-google.test.ts`: Added deterministic Google discovery-independent OIDC ID-token validation tests.
- `test/oidc-live.test.ts`: Existing opt-in live OIDC tests.
- `consumer/*` and `scripts/verify-consumer.sh`: Automated packed-tarball consumer verification.
- `scripts/verify-google-id-token.ts`: Opt-in interactive Google OIDC verification.
- `scripts/watch-google-jwks.mjs`: Opt-in Google signing-key rotation observer and local JWKS snapshots.
- `docs/google-oidc-live-testing.md`: Google Cloud setup and command instructions.
- `.github/workflows/auth.yml`: Service-integration and opt-in live OIDC tiers.
- `AUTH_RELEASE_READINESS.md`: Evidence report.

## Google verification matrix

| Check | Result | Evidence |
|---|---|---|
| Discovery metadata | PASS | HTTP 200 JSON from `https://accounts.google.com/.well-known/openid-configuration`; issuer is `https://accounts.google.com` |
| Issuer validation | PASS | Live discovery returned the trusted Google issuer; deterministic tests reject wrong issuer |
| JWKS retrieval | PASS | `jwks_uri` discovered from metadata; `https://www.googleapis.com/oauth2/v3/certs` returned a valid key set |
| Valid Google ID token | PASS | Real Google ID token validated via `scripts/verify-google-id-token.ts` |
| Signature validation | PASS | Real Google ID token signature validated; deterministic local RS256 tests also PASS |
| Audience validation | PASS | Real Google ID token audience validated; deterministic tests also PASS |
| Expiry validation | NOT RUN | Not attempted without a live token |
| Invalid signature rejection | PASS | Deterministic test suite |
| Invalid issuer/audience rejection | PASS | Deterministic test suite |
| Unsupported algorithm rejection | PASS | Deterministic test suite (`alg: none`, RS256 pin) |
| JWKS cache behavior | PASS | Deterministic local and live test evidence |
| Real provider key rotation | NOT OBSERVED | Google controls key lifecycle; not observed during this run |

## Signing-key rotation verification

| Verification | Result | Evidence |
|---|---|---|
| Deterministic key-A to key-B rotation | PASS | `test/oidc-jwks.test.ts`: accepts a new key after rotation once the cache expires; refuses the removed key afterwards |
| Deterministic key-A to key-B rotation within cache window | PASS | `test/oidc-jwks.test.ts`: refreshes JWKS for a new kid before cache expiry and reuses the refreshed JWKS |
| Unknown-`kid` JWKS refresh | PASS | `test/oidc-jwks.test.ts`: refetches once for an unknown kid and accepts a newly added key; rejects a kid that remains unpublished |
| Invalid-signature rejection | PASS | `test/oidc-jwks.test.ts`, `test/oidc-google.test.ts`, `test/security.test.ts` |
| JWKS cache-expiry behavior | PASS | `test/oidc-jwks.test.ts`: stops accepting a removed key after cache expiry |
| Concurrent unknown-`kid` behavior | PASS | `test/oidc-jwks.test.ts`: 10 concurrent unknown kids are rejected with bounded JWKS fetches (`fetchCount <= 20`) |
| Live Google discovery and JWKS access | PASS | `npm run verify:google:id-token` printed Google authorization URL and completed callback/token exchange; 200 response |
| Live Google ID-token validation | PASS | Real Google ID token validated; subject `101299963513251952819`, email verified |
| Live Google signing-key rotation | NOT OBSERVED | Google has two current RSA JWKS keys (`943a...`, `f10f...`); no key-set changes observed during a 60-second observer run; deterministic rotation tests passed |
| Regression suite | PASS 234/234 (0 fail, 0 skip) | `npm test` |
| Lint | PASS | `npm run lint` |
| Typecheck | PASS | `npm run typecheck` |
| Build | PASS | `npm run build` |
| Pack check | PASS | `npm run pack:check` |
| Consumer smoke (runtime + types) | PASS | Installed `oneunit-auth-2.0.2.tgz`, ran `consumer/smoke.mjs`, `tsc --noEmit` |
| Service integration (Redis + PostgreSQL) | PASS 14/14 | `REQUIRES_SERVICES=1 ... npx tsx --test test/distributed.test.ts` |
| Live opt-in tests | PASS 228 run / 1 skipped (no OIDC_ID_TOKEN) | `OIDC_LIVE=1 npm test` |
| Observer tests | PASS 6/6 (pure utilities and state round-trip) | `npm test` | |

Commands executed:

- `npm test`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run pack:check`
- `npm pack --pack-destination /tmp/scratchpad`
- `node /tmp/scratchpad/consumer-smoke/smoke.mjs` (installed tarball)
- `REQUIRES_SERVICES=1 DATABASE_URL=postgres://oneunittest:oneunittest@localhost:5432/oneunittest REDIS_URL=redis://localhost:6379 npx tsx --test test/distributed.test.ts`
- `OIDC_LIVE=1 npm test`
- `OIDC_LIVE=1 npm run verify:google:id-token` (successful after PKCE fix)
- `JWKS_WATCH_DIR=/tmp/scratchpad/google-jwks JWKS_WATCH_INTERVAL=1 timeout 4s node scripts/watch-google-jwks.mjs` (baseline captured, no changes)
- `JWKS_WATCH_DIR=/tmp/scratchpad/obs-long JWKS_WATCH_INTERVAL=10` run for ~60s (6 snapshots, 1 baseline event, no key-set changes)

## Redis and PostgreSQL

- Redis-compatible service (Valkey 9.1.2): 7/7 pass.
- PostgreSQL 18.6: 7/7 pass.
- Requirements included single-use consumption, atomic rotation, revocation races, failure safety, isolation, and persisted-state inspection.

## Defects discovered

- `IORedis` type import and compilation issues in distributed tests: fixed.
- `KeyObject` and server-close TypeScript issues in OIDC tests: fixed.
- Type/lint issues in deterministic Google OIDC tests: fixed.
- No production token-validation security control was weakened.

## Remaining limitations

- Live Google ID-token validation passed with `npm run verify:google:id-token` (interactive browser consent completed).
- Live Google key rotation was not observed.
- Opt-in CI live verification cannot fetch a token without interactive consent.


## Production security audit of documented limitations

### 1. Access tokens after session revocation

- Original behavior: Access tokens are stateless JWTs and remain syntactically
  valid until expiry. Immediate invalidation requires an configured
  `sessionStore`.
- Confirmed risk: Revocation is not global in stateless mode. This is a
  documented JWT trade-off, not an unenforced security promise.
- Existing control: `Auth.verify()` enforces session version (`sv`) when a
  `sessionStore` is configured; `revokeAllSessions()` bumps that version and
  makes all previously issued access and refresh tokens fail the version check.
  `revoke(refreshToken)` and `logout()` remove a refresh record.
- Status: Mitigated through opt-in session-store revocation. `revokeSession()` now
  stamps and checks a `sid` claim, so a single revoked session is rejected on
  `verify()` and `refresh()` without bumping the user-wide version. Stateless
  mode is intentionally retained and documented.
- Tests: `test/auth.test.ts`, `test/distributed.test.ts`,
  `test/security.test.ts` cover session version stamping, blocked refresh
  after revocation, and concurrent refresh rejection.

### 2. In-memory stores in multi-instance deployments

- Original behavior: `createMemoryRefreshStore` and `createMemoryStateStore`
  are process-local wrappers around Maps.
- Confirmed risk: Not suitable for horizontal scaling; refresh reuse, logout,
  and OAuth state must be shared.
- Existing control: Stores are interfaces (`RefreshStore`, `StateStore`,
  `SessionStore`) supplied by the caller. Redis/PostgreSQL implementations are
  demonstrated in `test/distributed.test.ts`; the package itself has no Redis
  runtime dependency.
- Status: Working as designed; in-memory stores are explicitly development-only.
- Tests: `test/distributed.test.ts` (14 pass with Redis and PostgreSQL).

### 3. JWKS refresh limited to one refresh per verification

- Original behavior: An unknown `kid` with a URL-backed JWKS records the cached
  set, clears cache, and performs one forced JWKS fetch.
- Confirmed risk: A concurrent, multi-hop key rotation cannot be followed
  through more than one transition per token; repeated tokens can each perform
  one additional refresh.
- Assessment: The single refresh is an intentional bounded-retry policy. It
  prevents request storms and does not accept a token unless the refreshed
  JWKS contains the matching key. No unbounded retry is introduced.
- Status: Intentionally retained and documented.
- Tests: `test/oidc-jwks.test.ts` covers cache expiry, within-cache refresh,
  unknown/unpublished kids, invalid signatures, concurrent unknown kids
  (`fetchCount <= 20`), outage, and malformed JWKS.

### 4. Live Google signing-key rotation

- Original behavior: Observer records Google discovery/JWKS snapshots and
  detects changed key sets. A recently run 60-second observation retained two
  current RSA keys and recorded one baseline event with no changes.
- Confirmed risk: None in the implementation; Google did not exhibit a new
  key in the observation window.
- Status: `NOT OBSERVED`. Deterministic rotation tests passed.
- Tests/commands: `npm run observe:google:jwks`, `npm run verify:google:id-token`.

## Final release recommendation

**READY WITH LIMITATIONS**
