# Security Red-Team Report

Package: `@oneunit/microservice`
Scope: package plus its example applications (`examples/basic.ts`, encryption harnesses, TCP integration examples)
Date: 2026-10-23

## Executive verdict
**PASS WITH LIMITATIONS**

No confirmed unresolved exploitable issue remained in the tested scope after remediation. Real execution paths, security dispatch, TCP frame handling, RPC/adapter security tests, encryption/envelope attacks, and package validation were exercised. Meaningful coverage and design limitations remain and are documented below.

## Attack coverage matrix
| Category | Status | Evidence |
|---|---|---|
| Authentication and identity | Tested | `test/identity/*`, adapter security suites |
| Authorization and privilege escalation | Tested | `test/identity/authorization.test.ts`, `test/core/secured-dispatcher.test.ts`, adapter security suites |
| Dispatcher, transport, middleware bypass | Tested | `test/core/secured-dispatcher.test.ts`, `test/adapters/network/tcp/*`, `test/adapters/rpc/*`, `test/adapters/messaging/*` |
| TCP framing and sockets | Tested | `test/transport/tcp-frame-parser.test.ts`, `test/adapters/network/tcp/*`, `examples/tcp-integration.ts` |
| tRPC HTTP procedures | Tested | `test/adapters/rpc/trpc.security.test.ts`, `test/adapters/rpc/trpc.http.security.test.ts` |
| Encryption and envelope handling | Tested | `test/security/encryption*.test.ts`, `examples/encryption-attack.ts`, `examples/envelope-attack.ts` |
| Replay protection | Partially tested | `test/security/replay-protection.test.ts`; crypto layer intentionally does not perform replay protection |
| Key exchange and signatures | Partially tested | `test/security/key-exchange.test.ts`, `test/security/signing.test.ts`; documented unauthenticated X25519 is application-dependent |
| Key providers and rotation | Partially tested | `test/security/key-provider.test.ts`, `test/security/key-rotation.test.ts` |
| Registry and discovery | Partially tested | `test/registry/*.test.ts`; Redis-specific dynamic attacks not run without Redis here |
| Kafka and NATS integrations | Partially tested | adapter security unit tests; real broker infrastructure not used |
| UDP transport | Tested and passed locally after SecuredDispatcher integration | `test/transport/udp.test.ts` |
| Configuration and startup | Tested | `test/config/*.test.ts`, example startup |
| Lifecycle and concurrency | Partially tested | `test/core/lifecycle.test.ts`, transport tests |
| Observability and information leakage | Tested | logger/audit/metrics tests plus adversarial harnesses |
| Packaging and dependency surface | Partially tested | `test/packaging.test.ts`, `pnpm run build` |

## Findings
1. Low — `examples/basic.ts` previously contained an insecure hardcoded fallback root key. Fixed by requiring `CRYPTO_ROOT_KEY` with at least 32 characters.
2. Informational — `keyId` is advisory and not bound cryptographically.
3. Informational — optional envelope `signature` is not verified by `EncryptionService`; consumers must verify signatures where required.
4. Informational — envelope authenticated metadata is plaintext by design.
5. Informational — encryption layer does not provide replay protection; consumers must use `ReplayProtection` or application logic.
6. Informational — unauthenticated X25519 requires an authenticated outer protocol/application verification.
7. Low — example configuration exposed credential-like placeholder tokens. Fixed by replacing them with empty strings.

## Fixes made
- `examples/basic.ts`: removed insecure hardcoded root-key fallback.
- `examples/config.example.json`: replaced `redis-auth-token` and `kafka-sasl-token` placeholders with empty strings.

## Validation results
- `pnpm typecheck`: exit 0
- `pnpm lint`: exit 0
- `pnpm test`: exit 0 — 71 test files, 1600 tests
- `pnpm build`: exit 0
- `pnpm verify`: exit 0
- `node examples/encryption-attack.ts`: exit 0
- `node examples/envelope-attack.ts`: exit 0
- `CRYPTO_ROOT_KEY=abcdefghijklmnopqrstuvwxyz123456 node examples/basic.ts`: exit 0

## Residual risks
- Redis, Kafka, and NATS dynamics were not verified against live infrastructure in this run.
- Some optional application-level security properties (signature verification, replay rejection, recipient authorization) are not enforced inside the cryptographic primitives by design.
- Intentionally public/legacy unprotected paths remain available when security is not explicitly requested.
- Timing-safe comparisons are implemented, but end-to-end constant-time claims were not statistically validated, per policy.

## Recommendation
The package is suitable for its intended use when consumers explicitly configure and enforce authentication, authorization, TLS, key management, replay protection, signature verification, and secret sourcing. Continue with live infrastructure, real HTTP/TCP adversarial soak testing, and dependency scanning before production deployment.
