# Contributing to @oneunit/server

Thank you for contributing to `@oneunit/server`. This document explains how to set up your environment, follow project conventions, and submit changes.

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Architecture Principles](#architecture-principles)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Examples](#examples)
- [Type Safety & Build](#type-safety--build)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Release & Packaging](#release--packaging)
- [Reporting Issues](#reporting-issues)

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [pnpm](https://pnpm.io/) (workspace uses pnpm; corepack is available)

### Getting Started

1. Clone the monorepo and navigate to the package:

```bash
cd packages/server
```

2. Install dependencies (from workspace root as appropriate).

3. Verify your environment:

```bash
pnpm typecheck
pnpm build
pnpm test
```

All three should pass before making changes.

## Project Structure

```text
packages/server/
├── src/                  # Source code (TypeScript implementation)
│   ├── server.ts         # CLI entry point
│   ├── index.ts          # Public root exports
│   ├── bootstrap.ts      # Core orchestration & lifecycle
│   ├── config/           # Environment & service config
│   ├── plugins/          # Builtin & modular plugins (core, http, security, etc.)
│   ├── hooks/            # Fastify request & server hooks
│   ├── health/           # Health registry, providers & route
│   ├── routes/           # Builtin routes (health route)
│   ├── lib/              # Shared utilities (formatters, cookies, system)
│   └── types/            # Public & internal TypeScript declarations
├── test/                 # Test suite (Vitest)
│   ├── bootstrap/        # Minimal & comprehensive startup integration tests
│   ├── failure/          # Startup failure, partial initialization & cleanup
│   ├── health/           # Health registry, providers & endpoint
│   ├── hooks/            # Request and server lifecycle hooks
│   ├── lifecycle/        # Server lifecycle, socket binding & graceful shutdown
│   ├── plugins/          # Plugin system orchestration & category suites
│   │   ├── core/         # Logger, errors, response management, msgpack
│   │   ├── documentation/# Swagger & Swagger UI
│   │   ├── http/         # CORS, helmet, cookie, compress, rate-limit, zod, multipart
│   │   ├── infrastructure/ # Database, Redis, Kafka lifecycle
│   │   ├── performance/  # Under-pressure monitoring
│   │   ├── realtime/     # Realtime / WebSocket plugin
│   │   └── security/     # CSRF protection
│   ├── types/            # TypeScript compilation test fixtures
│   └── unit/             # Unit tests for config, lib utilities & exports
│       ├── config/       # Environment loading & validation
│       └── lib/          # Formatters, cookies, metadata, system status
├── examples/             # Executable usage examples
│   ├── README.md         # Examples documentation & run guide
│   ├── ts/               # TypeScript examples (basic, plugins, hooks, configure, etc.)
│   └── js/               # Plain JavaScript examples
├── dist/                 # Compiled output (.js, .d.ts, .map)
├── ARCHITECTURE.md
├── README.md
├── CHANGELOG.md
└── CONTRIBUTING.md
```

## Architecture Principles

`ARCHITECTURE.md` is the source of truth. Follow these principles:

1. **Bootstrap is orchestration** — Registration order is deterministic and must remain predictable.
2. **Plugins are first-class** — Prefer composition via plugins over ad-hoc wiring.
3. **Lazy, safe loading** — Optional peer dependencies are loaded lazily via dynamic `import()` with try/catch. Graceful degradation for optional plugins; fail fast for infrastructure plugins when explicitly enabled but missing.
4. **Encapsulation** — Plugins should not leak global state inappropriately; use Fastify's encapsulation model.
5. **Public extension points** — Extend via custom plugins, `hooks`, `configure(app)`, health providers. Do not reach into internal modules.
6. **Deterministic defaults** — Respect documented defaults. Builtins follow the canonical ordering; infrastructure defaults to disabled.
7. **Health is framework-owned** — The built-in `/health` endpoint and registry are framework concerns; applications add providers via public API only.
8. **Graceful shutdown** — Opt-in (`gracefulShutdown: true`); avoid duplicating signal handlers in application code.
9. **Resource lifecycle** — Initialize resources only when needed; clean up on close.

## Coding Standards

### TypeScript

- Strict mode enabled. Avoid `any`. Prefer precise types and inference.
- Use `import type` for types-only imports.
- Avoid unnecessary type assertions/casts.
- Follow existing naming conventions.

### General

- Keep changes minimal and focused. Do not perform unrelated refactoring.
- No debug `console.log` in `src/` (CLI entry may print on direct execution; tests may use stdout intentionally).
- Never commit secrets, credentials, tokens, or `.env` files.
- Imports must only reference public API boundaries or Node.js built-ins. Do not import `src/*`, `dist/*`, or internal implementation paths from examples or outside modules.

### Public API

- Do not invent or rename public symbols without updating types, exports, README, and CHANGELOG as appropriate.
- Keep `package.json` `exports`, `main`, `module`, `types`, `files`, `dependencies`, and `peerDependencies`/`peerDependenciesMeta` consistent with the built artifact.
- `fastify-plugin` is a runtime dependency (not a peer). Optional peers remain optional.

## Testing

- Framework: [Vitest](https://vitest.dev/). Tests use real Fastify instances (`app.inject()`).
- Place new tests in the corresponding folder:
  - `test/unit/` for deterministic utility and config functions
  - `test/bootstrap/` for server creation and startup orchestration
  - `test/plugins/` for plugin registration, ordering, or specific plugin category tests
  - `test/health/` for health providers, registry, and checks
  - `test/hooks/` for request and server lifecycle hooks
  - `test/lifecycle/` for listen, address binding, and signal-handling shutdown
  - `test/failure/` for startup errors, fault recovery, and resource cleanup
  - `test/types/` for type validation
- Run all tests: `pnpm test`
- Watch mode: `pnpm test:watch`
- Add regression tests for fixes/behavior changes. Mirror existing test style (clear naming, cleanup in `afterEach`).
- Do not rely on external services (live Postgres, Redis, Kafka) for default tests; use mocks/stubs at external boundaries.

## Examples

- Location: `examples/`. See `examples/README.md` for the catalog.
- Examples must use only the public API (`@oneunit/server`) and Fastify/Node types.
- Executable: JS (ESM) and TS (top-level await). Both must run successfully:
  - TypeScript: `npx tsx examples/ts/<topic>/server.ts` or `pnpm example:basic`
  - JavaScript: `node examples/js/basic/server.js` or `pnpm example:basic:js`
- Keep examples minimal, readable, and production-oriented.
- Examples requiring optional deps must fail clearly if missing; do not silently degrade.
- Use `port: 0` for short-lived examples and call `close()` to exit cleanly.
- Update `examples/README.md` when adding/modifying examples.

## Type Safety & Build

- Typecheck: `pnpm typecheck` (runs `tsc -p tsconfig.json --noEmit`)
- Build: `pnpm build` (runs `tsc -p tsconfig.json`)
- Package check: `pnpm pack:check` (runs `npm pack --dry-run`)
- Declarations (`.d.ts`, `.d.ts.map`) and source maps are emitted to `dist/`.
- Ensure no new type errors. Preserve strictness.
- Verify built output matches `package.json` exports and `files`.

## Pull Request Guidelines

1. **Scope**: Small, focused changes. Link to issue if applicable.
2. **Tests**: Include/adjust tests. All existing tests must still pass.
3. **Docs**: Update README/ARCHITECTURE/CHANGELOG/examples as needed.
4. **Quality**: `pnpm typecheck && pnpm build && pnpm test` all pass.
5. **Description**: Explain what changed, why, and any behavioral impact.
6. **Boundaries**: Respect public API; justify any source change beyond examples/docs/tests.
7. **No unrelated changes**: Avoid whitespace-only churn outside touched files.

## Release & Packaging

- Versioning follows [SemVer](https://semver.org/). Update `CHANGELOG.md` for user-visible changes.
- Verify packaging: `npm pack --dry-run` (or `pnpm pack --dry-run`). Inspect tarball contents (expect `dist/`, `examples/`, `LICENSE`, `README.md`, `CHANGELOG.md`). Do not ship `src/`, tests, or secrets.
- Fresh consumer validation: install the packed tarball in a clean temp project and run a minimal import/startup (as done in release checks).
- Optional peers: ensure `peerDependenciesMeta` marks optional deps correctly; infrastructure plugins must fail fast only when explicitly enabled+missing.

## Reporting Issues

- Include reproduction steps, Node/OS versions, package version, and minimal code.
- Note whether issue is with defaults, plugin behavior, types, lifecycle, or packaging.
- Check `ARCHITECTURE.md` and existing issues first.
