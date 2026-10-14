# Test Matrix — @oneunit/microservice
 
**Package Version:** 1.0.0
**Date:** 2026-10-14
**Test Framework:** Vitest 3.2.7
**Coverage Provider:** v8
**Total Tests:** 1571 (including 34 adversarial tests)

---

## Legend

| Status | Meaning |
|--------|---------|
| ✅ Implemented + Tested | Code and unit tests exist, passing |
| 🔒 Adversarial Tested | Additional adversarial/negative tests added |

## Adversarial Tests (New)

| Feature | Test File | Tests | Status | Notes |
|---------|-----------|-------|--------|-------|
| Errors | test/adversarial/errors.adversarial.test.ts | 5 | ✅ 🔒 | Error handling and detection |
| Lifecycle | test/adversarial/lifecycle.adversarial.test.ts | 32 | ✅ 🔒 | Edge cases and concurrency |
| Registry | test/adversarial/registry.adversarial.test.ts | 4 | ✅ 🔒 | Concurrent operations |
| Config | test/adversarial/config.adversarial.test.ts | 5 | ✅ 🔒 | Input validation |
| IDs | test/adversarial/ids.adversarial.test.ts | 3 | ✅ 🔒 | Generation uniqueness |
| Transport | test/adversarial/transport.adversarial.test.ts | 2 | ✅ 🔒 | State management |
| Shutdown | test/adversarial/shutdown.adversarial.test.ts | 4 | ✅ 🔒 | Hook management |
| Logger | test/adversarial/logger.adversarial.test.ts | 4 | ✅ 🔒 | Context handling |
| Replay Protection | test/adversarial/replay-protection.adversarial.test.ts | 5 | ✅ 🔒 | Future timestamp, expiration, replay |
