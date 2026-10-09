# Test Matrix — @oneunit/microservice

**Package Version:** 1.0.0
**Date:** 2026-10-09
**Test Framework:** Vitest 1.6.1
**Coverage Provider:** v8

---

## Legend

| Status | Meaning |
|--------|---------|
| ✅ Implemented + Tested | Code and unit tests exist, passing |
| 🔄 Implemented + Partial Tests | Code exists, some tests, gaps remain |
| ⚠️ Implemented + No Tests | Code exists but no unit tests |
| 🚧 Partially Implemented | Some code, incomplete feature |
| ❌ Not Implemented | Architecture only, no code |
| 🔒 Security Tests | Dedicated security/negative tests |
| 📦 Integration Required | Needs external infrastructure |

---

## Core Modules

| Feature | Implementation | Existing Tests | Missing Cases | Test Level | External Req | Result |
|---------|---------------|----------------|---------------|------------|--------------|--------|
| Configuration Schema | `src/config/schema.ts` | 55 tests ✅ | — | Unit | None | ✅ |
| Config Loader | `src/config/loader.ts` | 13 tests ✅ | Env fallbacks, file not found | Unit | None | ✅ |
| Errors | `src/core/errors.ts` | 21 tests ✅ | — | Unit | None | ✅ |
| Capabilities | `src/core/capabilities.ts` | 22 tests ✅ | Interface compliance | Unit | None | ✅ |
| Lifecycle Manager | `src/core/lifecycle.ts` | 42 tests ✅ | — | Unit | None | ✅ |
| Application | `src/core/application.ts` | 18 tests ✅ | Integration with real deps | Unit | None | ✅ |
| Client | `src/core/client.ts` | 0 tests ⚠️ | All methods | Unit | None | ⚠️ |
| Server | `src/core/server.ts` | 0 tests ⚠️ | All methods | Unit | None | ⚠️ |

---

## Contracts

| Feature | Implementation | Existing Tests | Missing Cases | Test Level | External Req | Result |
|---------|---------------|----------------|---------------|------------|--------------|--------|
| Messages | `src/contracts/messages.ts` | 33 tests ✅ | — | Unit | None | ✅ |
| Events | `src/contracts/events.ts` | 10 tests ✅ | — | Unit | None | ✅ |
| Procedures | `src/contracts/procedures.ts` | 20 tests ✅ | — | Unit | None | ✅ |
| Schemas | `src/contracts/schemas.ts` | 33 tests ✅ | — | Unit | None | ✅ |
| Versions | `src/contracts/versions.ts` | 33 tests ✅ | — | Unit | None | ✅ |

---

## Identity & Authorization

| Feature | Implementation | Existing Tests | Missing Cases | Test Level | External Req | Result |
|---------|---------------|----------------|---------------|------------|--------------|--------|
| Service Identity | `src/identity/service-identity.ts` | 14 tests ✅ | — | Unit | None | ✅ |
| Credentials | `src/identity/credentials.ts` | 25 tests ✅ | — | Unit | None | ✅ |
| Authentication | `src/identity/authentication.ts` | 21 tests ✅ | — | Unit + 🔒 | None | ✅ |
| Authorization | `src/identity/authorization.ts` | 34 tests ✅ | — | Unit + 🔒 | None | ✅ |

---

## Security & Cryptography

| Feature | Implementation | Existing Tests | Missing Cases | Test Level | External Req | Result |
|---------|---------------|----------------|---------------|------------|--------------|--------|
| Encryption | `src/security/encryption.ts` | 42 tests ✅ | — | Unit + 🔒 | None | ✅ |
| Key Exchange | `src/security/key-exchange.ts` | 29 tests ✅ | — | Unit + 🔒 | None | ✅ |
| Signing | `src/security/signing.ts` | 37 tests ✅ | — | Unit + 🔒 | None | ✅ |
| Key Provider | `src/security/key-provider.ts` | 28 tests ✅ | — | Unit | None | ✅ |
| Key Rotation | `src/security/key-rotation.ts` | 26 tests ✅ | — | Unit | None | ✅ |
| Replay Protection | `src/security/replay-protection.ts` | 30 tests ✅ | — | Unit + 🔒 | None | ✅ |
| Crypto Types | `src/security/crypto-types.ts` | 21 tests ✅ | — | Unit | None | ✅ |

---

## Registry & Discovery

| Feature | Implementation | Existing Tests | Missing Cases | Test Level | External Req | Result |
|---------|---------------|----------------|---------------|------------|--------------|--------|
| Registry (Memory) | `src/registry/registry.ts` | 0 tests ⚠️ | Register, discover, lease | Unit | None | ⚠️ |
| Discovery | `src/registry/discovery.ts` | 0 tests ⚠️ | Query, filter | Unit | None | ⚠️ |
| Health | `src/registry/health.ts` | 0 tests ⚠️ | Health metadata | Unit | None | ⚠️ |
| Leases | `src/registry/leases.ts` | 0 tests ⚠️ | Renewal, expiration | Unit | None | ⚠️ |
| Redis Backend | `src/registry/redis/` | 0 tests ⚠️ | All drivers, failover | Unit + 📦 | Redis | ⚠️ |

---

## Transport Layer

| Feature | Implementation | Existing Tests | Missing Cases | Test Level | External Req | Result |
|---------|---------------|----------------|---------------|------------|--------------|--------|
| Base Transport | `src/transport/transport.ts` | 0 tests ⚠️ | Interface | Unit | None | ⚠️ |
| Transport Manager | `src/transport/manager.ts` | 0 tests ⚠️ | Routing, muxing | Unit | None | ⚠️ |
| Capabilities | `src/transport/capabilities.ts` | 0 tests ⚠️ | Capability matching | Unit | None | ⚠️ |

---

## Observability

| Feature | Implementation | Existing Tests | Missing Cases | Test Level | External Req | Result |
|---------|---------------|----------------|---------------|------------|--------------|--------|
| Logger | `src/observability/logger.ts` | 0 tests ⚠️ | Levels, redaction | Unit | None | ⚠️ |
| Metrics | `src/observability/metrics.ts` | 0 tests ⚠️ | Counters, histograms | Unit | None | ⚠️ |
| Tracing | `src/observability/tracing.ts` | 0 tests ⚠️ | Span creation, W3C | Unit | None | ⚠️ |
| Audit | `src/observability/audit.ts` | 0 tests ⚠️ | Audit events | Unit | None | ⚠️ |

---

## Internal Utilities

| Feature | Implementation | Existing Tests | Missing Cases | Test Level | External Req | Result |
|---------|---------------|----------------|---------------|------------|--------------|--------|
| IDs | `src/internal/ids.ts` | 0 tests ⚠️ | UUID generation | Unit | None | ⚠️ |
| Shutdown | `src/internal/shutdown.ts` | 0 tests ⚠️ | Signal handling | Unit | None | ⚠️ |

---

## Adapters — RPC

| Feature | Implementation | Existing Tests | Missing Cases | Test Level | External Req | Result |
|---------|---------------|----------------|---------------|------------|--------------|--------|
| tRPC Adapter | `src/adapters/rpc/trpc/index.ts` | 0 tests ⚠️ | Client/server, streaming | Unit + 📦 | None | ⚠️ |
| gRPC Adapter | `src/adapters/rpc/grpc/index.ts` | 0 tests ⚠️ | Client/server, streaming | Unit + 📦 | None | ⚠️ |
| Connect RPC Adapter | `src/adapters/rpc/connect/index.ts` | 0 tests ⚠️ | Client/server, streaming | Unit + 📦 | None | ⚠️ |

---

## Adapters — Network

| Feature | Implementation | Existing Tests | Missing Cases | Test Level | External Req | Result |
|---------|---------------|----------------|---------------|------------|--------------|--------|
| TCP Adapter | `src/adapters/network/tcp/index.ts` | 0 tests ⚠️ | Framing, backpressure, TLS | Unit + 🔒 + 📦 | None | ⚠️ |
| UDP Adapter | `src/adapters/network/udp/index.ts` | 0 tests ⚠️ | Packet validation, rate limit | Unit + 🔒 + 📦 | None | ⚠️ |

---

## Adapters — Messaging

| Feature | Implementation | Existing Tests | Missing Cases | Test Level | External Req | Result |
|---------|---------------|----------------|---------------|------------|--------------|--------|
| Kafka Adapter (Main) | `src/adapters/messaging/kafka/adapter.ts` | 0 tests ⚠️ | Driver selection | Unit | None | ⚠️ |
| Kafka Driver Resolver | `src/adapters/messaging/kafka/driver-resolver.ts` | 0 tests ⚠️ | Explicit/auto selection | Unit | None | ⚠️ |
| Kafka KafkaJS Driver | `src/adapters/messaging/kafka/kafkajs/adapter.ts` | 0 tests ⚠️ | Producer/consumer | Unit + 📦 | Kafka | ⚠️ |
| Kafka OneUnit Driver | `src/adapters/messaging/kafka/oneunit/adapter.ts` | 0 tests ⚠️ | Producer/consumer | Unit + 📦 | Kafka | ⚠️ |
| NATS Adapter | `src/adapters/messaging/nats/index.ts` | 0 tests ⚠️ | Core + JetStream | Unit + 📦 | NATS | ⚠️ |

---

## Redis Registry Drivers

| Feature | Implementation | Existing Tests | Missing Cases | Test Level | External Req | Result |
|---------|---------------|----------------|---------------|------------|--------------|--------|
| Redis Adapter | `src/registry/redis/adapter.ts` | 0 tests ⚠️ | Driver abstraction | Unit | None | ⚠️ |
| Redis Driver Resolver | `src/registry/redis/driver-resolver.ts` | 0 tests ⚠️ | Explicit/auto selection | Unit | None | ⚠️ |
| ioredis Driver | `src/registry/redis/ioredis/adapter.ts` | 0 tests ⚠️ | Connection, ops | Unit + 📦 | Redis | ⚠️ |
| node-redis Driver | `src/registry/redis/node-redis/adapter.ts` | 0 tests ⚠️ | Connection, ops | Unit + 📦 | Redis | ⚠️ |
| OneUnit Redis Driver | `src/registry/redis/oneunit/adapter.ts` | 0 tests ⚠️ | Connection, ops | Unit + 📦 | Redis | ⚠️ |

---

## Summary Statistics

| Category | Files | Tested Files | Coverage |
|----------|-------|--------------|----------|
| Core | 6 | 4 | 67% |
| Config | 2 | 2 | 100% |
| Contracts | 5 | 5 | 100% |
| Identity | 4 | 4 | 100% |
| Security | 7 | 7 | 100% |
| Registry | 5 | 0 | 0% |
| Transport | 3 | 0 | 0% |
| Observability | 4 | 0 | 0% |
| Internal | 2 | 0 | 0% |
| RPC Adapters | 3 | 0 | 0% |
| Network Adapters | 2 | 0 | 0% |
| Kafka Adapters | 4 | 0 | 0% |
| NATS Adapter | 1 | 0 | 0% |
| Redis Registry | 5 | 0 | 0% |
| **Total** | **53** | **22** | **~42%** |

---

## Priority Testing Order

1. **Contracts** — Public API validation, message envelopes
2. **Identity/Authorization** — Security boundaries, deny-by-default
3. **Security/Crypto** — Encryption, signing, replay protection
4. **Registry** — In-memory first, then Redis drivers
5. **Transport** — Base interfaces, manager
5. **Observability** — Logger, metrics, tracing, audit
6. **Internal** — IDs, shutdown
7. **RPC Adapters** — tRPC, gRPC, Connect
8. **Network Adapters** — TCP, UDP
9. **Kafka Adapters** — Driver selection, both drivers
10. **NATS Adapter** — Core and JetStream
11. **Redis Drivers** — All three drivers
12. **Integration Tests** — Real infrastructure
13. **Packaging Tests** — ESM exports, npm pack

---

## Blocked / Environmental Dependencies

| Test Area | Blocker | Required |
|-----------|---------|----------|
| Kafka Integration | External Kafka broker | 📦 |
| NATS Integration | External NATS server | 📦 |
| Redis Integration | External Redis server | 📦 |
| RPC Interop | Test servers | 📦 |
| TCP/UDP Integration | Network ports | 📦 |