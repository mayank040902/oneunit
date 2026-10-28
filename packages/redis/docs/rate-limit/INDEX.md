# Rate Limiting Documentation

This directory contains all documentation related to the `@oneunit/redis` rate limiting and traffic control module.

## Documents

| File | Description |
|------|-------------|
| [README.md](README.md) | **Main documentation** - Complete usage guide with all 16 capabilities, examples, trade-offs, and operational concerns |
| [COVERAGE_MATRIX.md](COVERAGE_MATRIX.md) | **Behavioral coverage matrix** - Detailed test coverage status for each of the 16 capabilities with implementation references |
| [FINAL_VERIFICATION_REPORT.md](FINAL_VERIFICATION_REPORT.md) | **Final verification report** - Complete test results, defects found/fixed, and production readiness assessment |
| [FEATURES.md](FEATURES.md) | **Feature overview** - High-level feature descriptions and capability list |

## Quick Navigation

### Getting Started
- [Quick Start](README.md#quick-start)
- [Core Algorithms](README.md#core-algorithms)
- [Advanced Features](README.md#advanced-features)

### Reference
- [API Reference](README.md#api-reference)
- [Operational Concerns](README.md#operational-concerns)
- [Performance Characteristics](README.md#performance-characteristics)

### Verification
- [Coverage Matrix](COVERAGE_MATRIX.md) - Test status per capability
- [Final Report](FINAL_VERIFICATION_REPORT.md) - Complete verification results

## Capability Status Summary

| # | Capability | Status |
|---|------------|--------|
| 1 | Fixed Window | ✅ VERIFIED |
| 2 | Sliding Window | ✅ VERIFIED |
| 3 | Token Bucket | ✅ VERIFIED |
| 4 | Leaky Bucket (Policing) | ✅ VERIFIED |
| 5 | Multi-Dimensional | ✅ VERIFIED |
| 6 | Weighted Requests | ✅ VERIFIED |
| 7 | Distributed Concurrency | ✅ VERIFIED |
| 8 | Distributed Semaphore | ⚠️ PARTIALLY VERIFIED |
| 9 | Daily/Monthly Quotas | ✅ VERIFIED |
| 10 | Burst Protection | ✅ VERIFIED |
| 11 | Retry-After Metadata | ✅ VERIFIED |
| 12 | Rate-Limit Metadata | ✅ VERIFIED |
| 13 | Fail-Open/Fail-Closed | ✅ VERIFIED |
| 14 | Adaptive Throttling | ⚠️ LOCAL ONLY |
| 15 | Load Shedding | ⚠️ LOCAL ONLY |
| 16 | Backpressure | ⚠️ LOCAL ONLY |

## Test Results

```
npm run verify  →  PASS
- TypeScript:    ✅ PASS
- ESLint:        ✅ PASS (17 pre-existing warnings)
- Tests:         ✅ PASS (693 tests)
- Examples:      ✅ PASS
- Pack check:    ✅ PASS
```