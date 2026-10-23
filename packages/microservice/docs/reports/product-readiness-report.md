# Production Readiness Report — @oneunit/microservice

## 1. Executive decision

**GO WITH CONDITIONS**

The package builds, typechecks, lints, and its currently available unit/integration tests pass. Real-service verification was completed for plaintext and secured Redis, plain and secured Kafka publish/denial paths, NATS Core, NATS outage recovery, and NATS JetStream basic flows. No committed secret or package-source mandatory runtime vulnerability was confirmed during this assessment. However, some advanced claims remain only partially verified, particularly consumer-level secured Kafka ACL behavior, node-redis runtime behavior, and load/soak capacity.

## 2. Scope and evidence

Repository revision: `0527f6784ca8c9836248db4402637a595c5fce8c`

Environment:
- Node.js `v24.21.0`
- pnpm `12.11.2`
- Redis/Valkey `9.1.2`
- Kafka `4.3.1` (KRaft)
- NATS `2.15.0`

Commands and results:
- `pnpm typecheck` — pass, exit `0`
- `pnpm lint` — pass, exit `0`
- `pnpm build` — pass, exit `0`
- `pnpm test` — 1607 passed, 22 skipped
- `pnpm verify` — pass, 1609 passed, 22 skipped
- `RUN_LIVE_INTEGRATION=1` targeted suites — Redis 8/9 passed + 1 skipped; secured Redis 4/4 passed; Kafka 4/4 passed; NATS 4/4 passed; NATS outage 1/1 passed
- `pnpm audit --audit-level=high` — failures are primarily development/test and transitively affected packages; see findings.
- `pnpm audit --audit-level=moderate` — 9 total findings: 2 critical, 1 high, 5 moderate, 1 low

Checks not executed in this repository/session:
- Full secured Kafka consumer-flow verification under ACL configuration
- node-redis adapter runtime verification (`redis` not installed)
- Deterministic long-duration load/soak measurements
- Release publishing and signed artifact verification

## 3. Findings table

| ID | Severity | Component / files | Evidence / uncertainty | Exploitability / impact | Reproduction / validation | Recommended fix | Release block? |
|---|---|---|---|---|---|---|---|
| F-1 | Medium | Dependency supply chain; `pnpm-lock.yaml`; CI workflow | `pnpm audit` reports critical `tinypool` findings through `vitest`; not a package runtime dependency | Affects build/test tooling only; no demonstrated production runtime compromise | `pnpm audit --audit-level=high` | Upgrade Vitest/Tinypool to patched versions and re-run lockfile/CI | No, unless release policy rejects dev-only advisories |
| F-2 | Medium | Kafka secured ACL consumers; `src/adapters/messaging/kafka/*` | Secured publisher and unauthorized denial tested; consumer receive path was attempted but not cleanly verified due topic/group naming and timing | Potential impaired consumer authorization or receive behavior if configuration is incorrect | Secured broker test run attempted with `localhost:9194` | Finalize consumer ACL test with exact topic/group mapping and repeat verification | Yes for full Kafka ACL claim |
| F-3 | Medium | Redis adapter runtime coverage; `src/registry/redis/node-redis/adapter.ts` | `redis` module is not installed in the evaluated environment | node-redis path is unverified; ioredis and oneunit paths are verified | `pnpm test` plus package availability check | Install `redis` in CI and run secured/node-redis integration tests | Yes for node-redis support claim |
| F-4 | Medium | Distributed registration identity | Registration now uses stable `instance:serviceId:instanceId` keying and atomic Redis `SET NX EX`; race tests for independent clients exist | Scope is per service/instance identity, not service-name or cluster-wide uniqueness | Concurrent registration integration tests | Document the identity scope and add multi-process cross-client verification | Partly; semantics are documented as scoped |
| F-5 | Low | NATS server hardening | NATS secured connection and permission behavior depend on external server configuration, especially disabled anonymous access | A misconfigured secured NATS server could allow anonymous or overly broad access | Local secured NATS profile run | Provide pinned secured NATS profile and mandatory server configuration documentation | No for adapter code; operational condition |
| F-6 | Informational | Load and soak testing | No sustained load/soak implementation and measurement was executed | No production-capacity claim is justified | N/A | Add configurable load/soak scripts and report machine-readable results | No for functionality; yes for performance claims |

## 4. Security coverage matrix

| Component | State | Notes |
|---|---|---|
| Redis TLS | Tested and passed | Trusted CA success and untrusted CA/hostname/invalid credential failure verified |
| Redis ACL / auth | Tested and passed | Authorized operation success and unauthorized operation failure verified |
| Redis recovery | Partially tested | Actual interruption/outage not re-run in this final assessment |
| Kafka TLS/SASL | Tested and passed | Authenticated connection and client certificate behavior verified against secured broker |
| Kafka ACL publish | Tested and passed | Authorized publish succeeded; unauthorized publish denied |
| Kafka ACL consumer | Partially tested | Unauthorized subscribe denied; successful consumer receive path pending verified mapping |
| NATS Core TLS/auth | Tested and passed | Secured connection and invalid credential rejection are covered by the local profile |
| NATS subject permissions | Partially tested / infrastructure dependent | Uses permission-capable server profile; complete authorization matrix not fully automated |
| NATS JetStream recovery | Tested and passed on basic path | Durable restart and redelivery exercised |
| Cryptography | Not fully independently audited in this pass | Dependent on repository tests and prior implementation review |

## 5. Production blockers (unresolved Critical / High)

No unresolved Critical or High finding in the package's own source was confirmed by this assessment. However, deployment must not claim:
- verified node-redis TLS behavior until installed and tested;
- fully verified Kafka consumer ACL behavior until receive-path evidence is recorded;
- any load, latency, throughput, memory, or capacity assurance without soak measurements.

## 6. Deployment conditions

Required conditions:
- Use Redis with TLS enabled and certificate verification, never plaintext TLS downgrade.
- Use validated credentials and least-privilege Redis/Kafka/NATS identities.
- Provision Kafka topics and NATS streams explicitly; auto-creation is not the intended production path.
- Use ioredis for secured Redis deployments until node-redis is independently verified.
- Provide application-level idempotency and deduplication for Kafka because delivery is at-least-once.
- Enable secret management, TLS certificate rotation, monitoring, audit logging, and bounded-resource alerts.

## 7. Remediation roadmap

Release-blocking:
- None confirmed for core package functionality.

Pre-release:
- Convert secured Kafka consumer receive ACL into a passing integration test.
- Run node-redis integration tests after installing `redis`.
- Complete malformed-record and interruption/recovery matrix for all supported backends.

Post-release:
- Add configurable load/soak scripts with machine-readable results.
- Publish infrastructure prerequisites and operations documentation.
- Upgrade vulnerable development dependencies and keep CI audit behavior clear.

## 8. Final rationale

The available evidence supports deployment of the package in a constrained, documented scope. Verified real-service authentication and denial behavior for Redis and Kafka publication supports a secure default direction. The remaining items are evidence gaps and operational requirements, not demonstrated Critical/High vulnerabilities. If node-redis, Kafka consumer ACL, or large-scale behavior is required for the deployment, the corresponding evidence must be obtained first.

Verified facts: builds, typecheck, lint, unit tests, and selected live integration tests pass.
Plausible risks: indirect dev-dependency advisories and backend configuration mistakes.
Untested assumptions: node-redis runtime behavior, full Kafka consumer ACL success, sustained load and resource behavior.
