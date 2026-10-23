# Production Readiness Report — `@oneunit/microservice`

Package: `@oneunit/microservice`
Repository location: `/home/lucius/Projects/oneunit/packages/microservice`
Audit date: 2026-10-23

## 1. Executive decision
**GO WITH CONDITIONS**

Core package validation and basic live infrastructure verification pass, but production features that depend on live Redis/Kafka/NATS TLS/SASL, JetStream, advanced failure recovery, and sustained load remain partially or unverified. Several protocol security properties are intentionally delegated to consumers.

## 2. Scope and evidence
Environment: Linux, Node.js v24.x, pnpm 12.x; live services available locally.

Commands and exit statuses:
- `pnpm typecheck` — 0
- `pnpm lint` — 0
- `pnpm test` — 0 (72 test files, 1607 tests)
- `pnpm build` — 0
- `pnpm verify` — 0
- `node examples/encryption-attack.ts` — 0
- `node examples/envelope-attack.ts` — 0
- `CRYPTO_ROOT_KEY=abcdefghijklmnopqrstuvwxyz123456 node examples/basic.ts` — 0
- Live Redis registration/discovery/updateHealth/renew/deregister script — 0
- Live Redis serviceName discovery script — 0
- Live Kafka (KafkaJS driver) publish/consume script — 0
- Live Kafka (OneUnit driver) connection script — 0
- Live NATS Core publish/subscribe script — 0

Checks not executed:
- Live JetStream integration
- Live Redis restart/auth/TLS scenarios
- Live Kafka SASL/TLS/reconnect/outage scenarios and OneUnit consumer semantics
- Live NATS JetStream/TLS/restart scenarios
- Production-scale load/soak testing
- Dependency vulnerability scan (not run as a configured check in this pass)

## 3. Findings table
| ID | Severity | Component/files | Evidence/uncertainty | Release blocker | Status |
|---|---|---|---|---|---|
| PR-01 | Low | Example app, `examples/basic.ts` | Hardcoded fallback root key existed | Previously yes | Fixed |
| PR-02 | Low | Example config, `examples/config.example.json` | Credential-like tokens in example config | No | Fixed |
| PR-03 | Informational | Crypto, `src/security/encryption.ts` | Cryptographic key binding now supported through signed envelopes | No | Partially fixed |
| PR-04 | Informational | Crypto, `src/security/encryption.ts` | Optional envelope signatures now verifiable when required | No | Partially fixed |
| PR-05 | Informational | Crypto/key exchange, `src/security/key-exchange.ts` | Documented unauthenticated X25519 | No | Design limitation |
| PR-06 | Informational | UDP adapter, `src/adapters/network/udp/index.ts` | Shared `SecuredDispatcher` integration added | No | Fixed at integration boundary |
| PR-07 | Uncertain | Registry Redis, `src/registry/redis/*` | Live Redis basic pass; restart/auth/TLS/atomicity not tested | Conditional | Not blocked for basic use |
| PR-08 | Uncertain | Messaging adapters, `src/adapters/messaging/kafka/*`, `nats/*` | Live Kafka/NATS basic pass; advanced semantics not tested | Conditional | Not blocked for basic use |

No unresolved Critical or High finding is reported in the tested scope. Advanced live infrastructure results remain incomplete and may change conclusions.

## 4. Security coverage matrix
| Component | Status |
|---|---|
| Authentication (API key, JWT, X.509) | Tested and passed locally |
| Authorization (allowlist, RBAC, composite) | Tested and passed locally |
| Secured dispatcher and transports | Tested and passed locally, including UDP real-socket tests |
| TCP framing/adapter | Tested and passed locally |
| tRPC HTTP | Tested and passed locally |
| gRPC/Connect | Partially tested |
| Kafka/NATS | Partially tested (basic live pass) |
| Encryption and envelopes | Tested and passed locally, including adversarial signature binding |
| Replay protection | Partially tested |
| Key exchange and signatures | Partially tested |
| Key providers and rotation | Partially tested |
| Registry in-memory | Tested and passed locally |
| Registry Redis | Basic live pass; advanced unverified |
| UDP | Tested and passed locally |
| Config/startup | Tested and passed locally |
| Observability | Tested and passed locally |
| Packaging/exports | Tested and passed locally |

## 5. Production blockers
None confirmed for basic local package use after remediation.

Conditions for production deployment:
1. Explicitly configure authentication and authorization on every inbound boundary.
2. Provide TLS and validate certificates for networked traffic.
3. Use secret managers for `CRYPTO_ROOT_KEY`, broker credentials, registry credentials, and service identities.
4. Verify live Redis/Kafka/NATS behavior for all features used, especially TLS, recovery, and replay-sensitive workflows.
5. Explicitly implement application-level replay protection, signature verification policy, recipient authorization, and authenticated key exchange where required.

## 6. Deployment conditions
- Do not use example fallback secrets.
- Use unique production service IDs and certificates.
- Run `pnpm verify` and relevant live integration tests before release.
- Enable audit and monitoring for security failures and dependency health.
- Document unresolved operational procedures for key rotation, credential rotation, shutdown, and broker/registry recovery.

## 7. Remediation roadmap
Release-blocking:
- None confirmed in tested local scope; all advanced live-infrastructure conditions must pass before those features are treated as production-ready.

Pre-release:
- Run JetStream, TLS/SASL, restart/outage, and load tests.
- Run dependency/security audits.
- Review application-level security policy for replay/signature/recipient binding.

Post-release:
- Add long-duration soak tests and operational runbooks.

## 8. Final rationale
The evidence supports **GO WITH CONDITIONS**, not unconditional GO. The package passes local build/test, security, encryption, and basic live infrastructure checks. However, final production readiness for advanced infrastructure and scale scenarios remains incomplete and is reported as such.
