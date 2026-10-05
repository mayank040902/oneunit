# Contributing to `@oneunit/realtime`

Thank you for your interest in contributing! This package manages realtime WebSocket
connections, channels, and delivery within a single Node.js process. Because it
handles raw network sockets and untrusted client traffic, security, stability, and
isolation are paramount.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Reporting a Security Vulnerability](#reporting-a-security-vulnerability)
- [Getting Set Up](#getting-set-up)
  - [Working Directly in `packages/realtime`](#working-directly-in-packagesrealtime)
  - [Working from the Monorepo Root](#working-from-the-monorepo-root)
  - [Useful Commands](#useful-commands)
- [The Checks a Pull Request Must Pass](#the-checks-a-pull-request-must-pass)
- [Writing Tests](#writing-tests)
  - [Test Suite Structure](#test-suite-structure)
  - [A Regression Test Must Fail Without Its Fix](#a-regression-test-must-fail-without-its-fix)
  - [Timing-Dependent Tests](#timing-dependent-tests)
- [The Five Architectural Rules](#the-five-architectural-rules)
- [Security Checklist](#security-checklist)
- [Cryptography Guidelines](#cryptography-guidelines)
- [Dependency Policy](#dependency-policy)
- [Packaging and Sourcemaps](#packaging-and-sourcemaps)
- [Publishing and Releasing](#publishing-and-releasing)
  - [Direct npm CLI Publishing](#direct-npm-cli-publishing)
  - [Automated CI Release Workflow](#automated-ci-release-workflow)
- [Examples and Runnable Scripts](#examples-and-runnable-scripts)

---

## Prerequisites

- **Node.js 20+**
- **npm** or **pnpm**
- No external message broker (Kafka, Redis) is required — all tests run fully in-memory or on local ephemeral ports.

---

## Reporting a Security Vulnerability

Do **not** open a public issue. Use GitHub's private vulnerability reporting feature for this repository or contact the maintainers directly.

Please include:
1. Affected package version.
2. Reproduction script or scenario.
3. Expected impact.
4. Details of any safe configuration (e.g., whether the vulnerability only affects deployments lacking an `authenticate` hook).

---

## Getting Set Up

### Working Directly in `packages/realtime`

```bash
cd packages/realtime

# Install dependencies
npm install

# Run full verification
npm run verify
```

### Working from the Monorepo Root

```bash
# Verify realtime package from root
pnpm --filter @oneunit/realtime verify

# Run test suite from root
pnpm --filter @oneunit/realtime test
```

### Useful Commands

| Command | Description |
| :--- | :--- |
| `npm run build` | Cleans and compiles TypeScript to `dist/`. |
| `npm run dev` | Runs TypeScript compiler in watch mode. |
| `npm run typecheck` | Type-checks `src/`, `test/`, and `examples/`. |
| `npm test` | Runs the test suite via Vitest. |
| `npm run test:watch` | Runs Vitest in interactive watch mode. |
| `npm run lint` | Runs ESLint on `src/` and `test/`. |
| `npm run pack:check` | Verifies tarball contents with `npm pack --dry-run`. |
| `npm run verify` | Complete release gate (build + typecheck + lint + test + pack:check). |

---

## The Checks a Pull Request Must Pass

Every pull request must pass the automated verification gate before merging:

```bash
npm run verify
```

`npm run verify` executes five sequential steps:
1. **`build`**: Cleans `dist/` and `tsconfig.tsbuildinfo`, then compiles TypeScript declarations and JavaScript bundles.
2. **`typecheck`**: Strict type checking across `src/`, `test/`, and `examples/`.
3. **`lint`**: ESLint validation.
4. **`test`**: Executes the 7 test suites (145+ tests), including real WebSocket client/server exchanges.
5. **`pack:check`**: Dry-runs `npm pack` to ensure only intended artifacts ship.

---

## Writing Tests

Tests are written using [Vitest](https://vitest.dev/).

```bash
# Inside packages/realtime:
npm test

# Run tests in watch mode:
npm run test:watch

# From monorepo root:
pnpm --filter @oneunit/realtime test
```

### Test Suite Structure

The test suite in `test/` is organized into focused domains:

| Test File | Scope & Invariants Tested |
| :--- | :--- |
| `test/hub.test.ts` | In-memory channel operations, client management, delivery, backpressure, capacity limits, shared heartbeat sweeping, and lifecycle. |
| `test/adapter.test.ts` | Transport adapter logic, WebSocket upgrade routing, pre-handshake HTTP 401 refusals, server ownership. |
| `test/plugin.test.ts` | Fastify plugin registration, `fastify` vs `ws` library modes, multi-instance isolation, and graceful shutdown hooks. |
| `test/e2ee.test.ts` | Libsodium key generation, X25519 ECDH key exchange, XSalsa20-Poly1305 encryption/decryption, skip-on-missing-key rule. |
| `test/boundaries.test.ts` | Static import analysis enforcing architectural boundaries (e.g. `hub.ts` never imports `ws` or `fastify`). |
| `test/integration.test.ts` | Real-world Fastify server and WebSocket clients testing end-to-end upgrades, authentication, and authorization. |
| `test/examples.test.ts` | Live process execution verifying that every script in `examples/` runs without errors. |

### A Regression Test Must Fail Without Its Fix

Every bug fix should be accompanied by a regression test that fails against the code before the fix. For example:
- A test verifying that a refused peer receives HTTP 401 must confirm that no open socket is created.
- A test covering JSON decoding must assert that client text messages do not trigger notepack trailing-byte errors.

### Timing-Dependent Tests

Never use fixed arbitrary sleeps (e.g. `setTimeout(..., 1000)`). Use bounded polling predicates with explicit timeout rejections (`waitFor` helper) to guarantee deterministic execution across CI runners.

---

## The Five Architectural Rules

1. **The core stays transport-neutral**: `src/hub.ts` and `src/errors.ts` must never import `ws`, `fastify`, or any broker library. `src/adapter.ts` must never import `fastify`. This is enforced by `test/boundaries.test.ts`.
2. **A bad peer is a counter, not an exception**: Delivery operations (`send`, `broadcast`, frame encoding) must never throw due to a single slow, disconnected, or malformed peer. Count the failure, log it if configured, and move on.
3. **A refused peer costs nothing**: Authenticate before admitting a connection. If the transport owns the upgrade, refuse with HTTP 401 before completing the handshake so no socket or resources are allocated.
4. **No state crosses instances**: No module-level singletons or shared mutable Maps. Two hubs in the same process must be completely isolated.
5. **Claim only what you can observe**: If a transport does not expose `bufferedAmount`, do not guess byte counts. Rely on consecutive-drop counters and document the behavior honestly.

---

## Security Checklist

Before submitting a pull request that touches connection handling, delivery, or authentication, verify:

- [ ] **Authentication runs before membership**: A refused peer must never appear in `participants()`, hold a channel, cost a heartbeat, or register an E2EE key.
- [ ] **Protocol-appropriate refusal**: Un-upgraded HTTP requests get HTTP status codes (`401`, `503`); established sockets receive WebSocket close codes (`1008`).
- [ ] **Authorization covers channel names**: Channel names are validated against length limits, whitespace, and control characters before subscription.
- [ ] **Limits are enforced before allocation**: Check `maxMessageSize` on the encoded binary frame before allocating memory; verify channel and connection capacity before map insertion.
- [ ] **No sensitive credentials logged**: Passwords, bearer tokens, cookies, and message payloads must never reach `logger` or `onEvent`.
- [ ] **Errors carry machine-readable codes**: Subclasses of `RealtimeError` must carry a string `code` property (`AUTHORIZATION_ERROR`, `CONNECTION_LIMIT`, etc.).
- [ ] **Single unref'd timer**: The heartbeat uses one shared unref'd timer so test runners and CLI scripts exit cleanly.
- [ ] **Ordered teardown**: Terminate active sockets and detach listeners before the HTTP server finishes closing.

---

## Cryptography Guidelines

All cryptographic operations live in `src/e2ee.ts` and wrap [libsodium-wrappers](https://github.com/jedisct1/libsodium.js):

- **Zero Hand-Rolled Crypto**: Never introduce custom hashing, padding, or cipher implementations.
- **Strict Boundary Validation**: Validate all public keys and ciphertexts by exact length and encoding; throw typed errors instead of letting Libsodium panic.
- **Skip Missing Keys**: When broadcasting to an encrypted channel, participants without a registered public key are **skipped, never downgraded to plaintext**.
- **Accurate Threat Model**: E2EE protects against wire observers and other channel members. Never document it as protecting against a malicious server operator who controls the hub process.

---

## Dependency Policy

- Direct dependencies must be strictly justified in the pull request: why the standard library or an existing dependency cannot solve the problem.
- Broker clients (Kafka, Redis, RabbitMQ) must **never** be added as dependencies of this package.
- `ws` is a runtime dependency because the standalone adapter is a primary supported interface. It is imported lazily.
- Fastify and `@fastify/websocket` remain optional peer dependencies.

---

## Packaging and Sourcemaps

- `package.json` includes both `"dist"` and `"src"` in `"files"`. Because TypeScript maps point to `../src/*.ts`, shipping `src/` enables flawless jump-to-definition and debug stepping for consumers.
- The `clean` script cleans `dist/` before every build, preventing deleted source files from leaving orphaned compiled outputs in the published package.

---

## Publishing and Releasing

The package is configured for public npm distribution under the `@oneunit` scope:

```json
"publishConfig": {
  "access": "public",
  "registry": "https://registry.npmjs.org/"
}
```

### Direct npm CLI Publishing

`package.json` defines `"prepublishOnly": "npm run verify"`, ensuring a clean build, strict typecheck, linting, and full test suite execution precede every publish:

```bash
# Inside packages/realtime:
npm login
npm publish
```

### Automated CI Release Workflow

Releases are driven by git tags: `git tag realtime-v2.0.0 && git push origin realtime-v2.0.0`.
`.github/workflows/realtime.yml` verifies on Node 20, 22, and 24, tests tarball installation in a clean environment, and publishes to npm when the tag matches `package.json`.

---

## Examples and Runnable Scripts

The `examples/` directory provides complete, runnable sample applications:

| Example File | Run Command | Description |
| :--- | :--- | :--- |
| `examples/standalone.ts` | `npm run example:standalone` | Standalone Node HTTP server with pre-handshake upgrade authentication. |
| `examples/chat.ts` | `npm run example:chat` | Multi-room Fastify chat server with room-based authorization. |
| `examples/client.ts` | `npm run example:client` | WebSocket client for `chat.ts`. |
| `examples/plugin-ws.ts` | `npm run example:plugin-ws` | Fastify integration using `websocketLibrary: "ws"`. |
| `examples/e2ee.ts` | `npm run example:e2ee` | End-to-end encrypted hub with key exchange. |
| `examples/e2ee-client.ts` | `npm run example:e2ee-client` | Client exchanging encrypted frames with `e2ee.ts`. |
| `examples/adapter.ts` | `npm run example:adapter` | External broker adapter pattern broadcasting across hubs. |

All examples are executed as live tests by `test/examples.test.ts`.