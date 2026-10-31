# Contributing to @oneunit/database

Thank you for your interest in contributing! This guide covers everything you need to get started.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Coding Guidelines](#coding-guidelines)
  - [TypeScript](#typescript)
  - [API Design](#api-design)
  - [Error Handling](#error-handling)
  - [Security](#security)
  - [Code Style](#code-style)
- [Testing](#testing)
- [Common Tasks](#common-tasks)
- [Pull Request Process](#pull-request-process)
- [Release Process (Maintainers)](#release-process-maintainers)
- [Getting Help](#getting-help)

---

## Prerequisites

- **Node.js 20+**
- **npm** (ships with Node.js)
- A code editor with TypeScript support (VS Code recommended)
- No live PostgreSQL instance needed — all tests use mocks

---

## Development Setup

```bash
# Clone the monorepo
git clone https://github.com/mayank040902/oneunit.git
cd oneunit/packages/database

# Install dependencies
npm install

# Verify everything works
npm run typecheck && npm test && npm run build
```

### Useful Commands

| Command | Description |
| :--- | :--- |
| `npm run dev` | Watch mode — recompiles on save |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | Type-check without emitting (strict mode) |
| `npm test` | Run all tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run pack:check` | Dry-run `npm pack` to verify package contents |

---

## Project Structure

```
packages/database/
├── src/                         # Source code (TypeScript, ESM)
│   ├── index.ts                 # Public barrel — all re-exports
│   ├── database.ts              # createDatabase() — composition root
│   ├── types.ts                 # All TypeScript interfaces and types
│   ├── json-serialization.ts    # JSON encode/decode utilities
│   │
│   ├── client/                  # Connection, execution, lifecycle
│   │   ├── pool.ts              # Pool creation and config
│   │   ├── config.ts            # Environment-based config loading
│   │   ├── client.ts            # Query execution (query, queryOne, prepare)
│   │   ├── transaction.ts       # Transaction management
│   │   ├── batch.ts             # Bulk insert helpers
│   │   ├── stream.ts            # pg-query-stream wrapper
│   │   ├── cursor.ts            # pg-cursor wrapper
│   │   ├── check.ts             # Health checks
│   │   ├── shutdown.ts          # Graceful pool shutdown
│   │   ├── retry.ts             # Retry with exponential backoff
│   │   ├── errors.ts            # Error classes and classifiers
│   │   └── hooks.ts             # Instrumentation hooks and metrics
│   │
│   ├── query/                   # SQL construction
│   │   ├── sql.ts               # sql`` tagged template
│   │   └── builder.ts           # Fluent QueryBuilder
│   │
│   ├── model/                   # Table-level CRUD
│   │   └── model.ts             # createModel(), createModelFactory()
│   │
│   ├── schema/                  # DDL operations
│   │   ├── schema.ts            # SchemaManager facade
│   │   ├── create.ts            # CREATE TABLE / INDEX
│   │   ├── alter.ts             # ALTER TABLE
│   │   ├── drop.ts              # DROP TABLE / INDEX
│   │   ├── constrain.ts         # Constraints (unique, FK, check)
│   │   └── migrate.ts           # Migration runner
│   │
│   └── column/                  # Column definition helpers
│       ├── id.ts                # id(), bigIntId(), uuid()
│       └── timestamp.ts         # timestamp()
│
│   └── sharding/                  # Database sharding
│       ├── shard-manager.ts     # Per-shard pool lifecycle
│       ├── shard-router.ts      # Shard key routing
│       ├── strategies.ts        # Hash and directory strategies
│       ├── index.ts             # Sharding barrel exports
│       └── errors.ts            # Sharding error classes
│
├── test/                        # Tests (vitest), mirrors src/ structure
│   ├── client/                  # client, transaction, retry, batch, check, stream, cursor, shutdown
│   ├── config/                  # config loading, idleTransactionTimeout validation
│   ├── query/                   # QueryBuilder
│   ├── schema/                  # migrator, schema manager
│   ├── model/                   # model CRUD
│   ├── json-serialization/      # encode/decode utilities
│   ├── errors/                  # error classifiers
│   ├── database.test.js         # createDatabase() composition surface
│   └── edge-cases.test.js       # edge, extreme, behaviour & real-world scenarios
│   └── sharding/                  # sharding config, routing, pool lifecycle
├── dist/                        # Compiled output (git-ignored, auto-generated)
├── examples/                    # Runnable usage examples
├── ARCHITECTURE.md              # Internal design reference
├── CHANGELOG.md                 # Version history (Keep a Changelog format)
├── CONTRIBUTING.md              # This file
├── LICENSE                      # MIT
├── README.md                    # User-facing documentation
├── package.json
└── tsconfig.json
```

For a deeper dive into internals, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Development Workflow

### 1. Create a Branch

```bash
git checkout -b feature/your-feature   # or fix/your-fix, docs/your-docs
```

### 2. Write Your Code

- Implement changes in `src/` (TypeScript)
- Follow existing patterns — the codebase uses composition with factory functions, not classes
- Add or update tests in `test/`

### 3. Validate

```bash
# Quick check during development
npm run typecheck && npm test

# Full validation before submitting
npm run typecheck && npm test && npm run build && npm run pack:check
```

### 4. Update Documentation

- **User-facing changes** → update [README.md](README.md)
- **Internal changes** → update [ARCHITECTURE.md](ARCHITECTURE.md)
- **All changes** → add an entry to [CHANGELOG.md](CHANGELOG.md) under `## [Unreleased]`

---

## Coding Guidelines

### TypeScript

- **Strict mode** is enabled — no `any`, no implicit any
- Use **explicit return types** for all public/exported functions
- Prefer `interface` over `type` for object shapes
- Export types alongside their implementations
- All source is ESM (`"type": "module"` in package.json)

### API Design

- **Backward compatibility** — add new exports alongside existing ones; don't remove or rename public API without a major version bump
- **No workspace runtime dependencies** — `@oneunit/database` must remain standalone; it depends only on `pg` at runtime
- **Parameterized SQL only** — never interpolate untrusted values into SQL strings; always use `$1, $2, …` placeholders
- **Retries are opt-in** — only transient errors (serialization failures, deadlocks, connection loss) are retryable
- **Factory composition** — new features should follow the `createX(dependencies) → API` pattern used throughout the codebase (see [ARCHITECTURE.md](ARCHITECTURE.md#composition-model))

### Error Handling

- Wrap raw `pg` errors with `normalizeError()` → produces a `DatabaseError`
- Preserve the original error on `.cause`
- Use the classifier functions (`isUniqueViolation`, `isTransientError`, etc.) rather than checking error codes directly
- `TimeoutError` extends `DatabaseError` and is always marked `transient: true`

### Security

- **Never log credentials** — `loadDatabaseConfig()` redacts passwords; respect this pattern
- **Never log query parameters by default** — the `logParameters: true` opt-in exists for a reason
- Validate file paths in SSL config (`parseSslConfig()` already does this)

### Code Style

- 4-space indentation
- Trailing commas in multiline constructs
- Descriptive variable names — favor clarity over brevity
- Keep functions small and focused — one responsibility per function

---

## Testing

### Philosophy

- **No live PostgreSQL required** — all tests use mocked `pg.Pool` and `PoolClient`
- **Fast** — the full suite runs in seconds
- **Isolated** — each test sets up its own mocks; no shared mutable state
- **Structure** — tests live under `test/` and mirror `src/` (e.g., `test/client/client.test.js`, `test/query/builder.test.js`, `test/model/model.test.js`, etc.)

### Running Tests

```bash
npm test                                 # all tests (vitest)
npm run test:watch                       # re-run on file changes
npx vitest run test/client/client.test.js   # single file
npx vitest run test/client               # one directory
```

### Writing Tests

- Test files go in `test/` (or a subdirectory mirroring `src/`) with the naming convention `*.test.js`
- Use vitest's `describe` / `it` / `expect` API
- Mock `pg.Pool` and `PoolClient` — see existing tests for patterns
- Test both success paths and error paths
- For error classifiers, test with realistic PostgreSQL error codes

### Test Coverage Map

| Area | Test Location |
| :--- | :--- |
| Database composition | `test/database.test.js` |
| Query execution | `test/client/client.test.js` |
| Config loading | `test/config/config.test.js` |
| Error handling | `test/errors/errors.test.js` |
| Health & shutdown | `test/client/check.test.js`, `test/client/shutdown.test.js` |
| Retry logic | `test/client/retry.test.js` |
| Transactions | `test/client/transaction.test.js` |
| Batch & models | `test/client/batch.test.js`, `test/model/model.test.js` |
| Migrations | `test/schema/migrator.test.js` |
| Query builder | `test/query/builder.test.js` |
| Serialization | `test/json-serialization/serialization.test.js` |
| Schema DDL | `test/schema/schema.test.js` |
| Streaming / cursor | `test/client/stream.test.js`, `test/client/cursor.test.js` |
| Edge / extreme / real-world | `test/edge-cases.test.js` |
| Sharding (all 9 strategies + unified API) | `test/sharding/config.test.js`, `test/sharding/execution.test.js`, `test/sharding/strategies.test.js` |

---

## Common Tasks

### Adding a New Public Export

1. Implement in the appropriate `src/` module
2. Export from the module's `index.ts` barrel
3. Re-export from `src/index.ts`
4. Add TypeScript types/interfaces to `src/types.ts`
5. Add tests
6. Update README.md if user-facing

### Adding a Query Builder Method

1. Add the method to the `QueryBuilder` class in `src/query/builder.ts`
2. Add the type signature to the `QueryBuilder` interface in `src/types.ts`
3. Add tests in `test/query/builder.test.js`

### Adding a Model Method

1. Add the method in `src/model/model.ts`
2. Add the type signature to the `Model` interface in `src/types.ts`
3. Add tests in `test/model/model.test.js`

### Adding an Error Classifier

1. Add the PostgreSQL error code constant and classifier function in `src/client/errors.ts`
2. Export the classifier
3. Add the type declaration in `src/types.ts`
4. Add tests in `test/errors/errors.test.js`
5. Document in README.md error helpers table

### Adding a Configuration Variable

1. Add the env variable mapping in `loadDatabaseConfig()` in `src/client/config.ts`
2. Add tests in `test/config/config.test.js`
3. Update the configuration table in README.md

### Configuring idleTransactionTimeout

The `idleTransactionTimeout` option is a nested object on `DatabaseConfig`:

```typescript
interface IdleTransactionTimeout {
    enabled: boolean;
    timeout?: number;
}
```

1. Add validation in `validateIdleTransactionTimeout()` in `src/client/config.ts`
2. Add option-to-pg-options merging in `mergeIdleTransactionOptions()` in `src/client/config.ts`
3. Add tests in `test/config/idle-transaction-timeout.test.js`
4. Update README.md configuration examples
5. Update ARCHITECTURE.md if the connection lifecycle changes

### Adding a Sharding Strategy

1. Implement the `ShardStrategy` interface in `src/sharding/strategies.ts`
2. Register the strategy in the `STRATEGY_REGISTRY` map in `src/sharding/strategies.ts`
3. Add the strategy name to the `ShardStrategyName` union in `src/types.ts`
4. Add strategy-specific config interface to the `ShardingConfig` discriminated union in `src/types.ts`
5. Handle strategy-specific options in `createDatabase()` in `src/database.ts`
6. Export the strategy class from `src/sharding/index.ts` and `src/index.ts`
7. Add comprehensive tests in `test/sharding/strategies.test.js`
8. Update README.md sharding section
9. Update ARCHITECTURE.md module map

### Adding a Schema Operation

1. Implement in the appropriate `src/schema/*.ts` file
2. Wire it into `createSchemaManager()` in `src/schema/schema.ts`
3. Add the type to the relevant interface (`SchemaCreate`, `SchemaAlter`, `SchemaDrop`, or `SchemaConstrain`) in `src/types.ts`
4. Add tests

---

## Pull Request Process

### Before Submitting

1. **Fork** the repository and create your branch
2. Make your changes following the guidelines above
3. Run the full validation suite:
   ```bash
   npm run typecheck && npm test && npm run build && npm run pack:check
   ```
4. Update `CHANGELOG.md` under `## [Unreleased]`

### PR Checklist

- [ ] TypeScript compiles without errors (`npm run typecheck`)
- [ ] All tests pass (`npm test`)
- [ ] New functionality has tests
- [ ] `CHANGELOG.md` updated
- [ ] No new runtime dependencies added
- [ ] No credential or parameter logging by default
- [ ] Backward compatible (no breaking changes without discussion)
- [ ] README.md updated (if user-facing)

### What to Expect

- A maintainer will review your PR, usually within a few days
- You may be asked to make revisions — this is normal and collaborative
- Once approved, a maintainer will merge and handle the release

---

## Release Process (Maintainers)

```bash
# 1. Move CHANGELOG entries from [Unreleased] to the new version heading
# 2. Bump version in package.json (follow semver)

# 3. Full validation
npm run typecheck && npm test && npm run build && npm run pack:check

# 4. Commit and tag
git commit -am "release(database): vX.Y.Z"
git tag database-vX.Y.Z

# 5. Publish to npm
npm publish --access public

# 6. Push
git push origin main --tags
```

---

## Getting Help

- **Issues**: [github.com/mayank040902/oneunit/issues](https://github.com/mayank040902/oneunit/issues)
- **Discussions**: [github.com/mayank040902/oneunit/discussions](https://github.com/mayank040902/oneunit/discussions)

---

## Code of Conduct

Be respectful, inclusive, and constructive. See [GitHub Community Guidelines](https://docs.github.com/en/site-policy/github-terms/github-community-guidelines).

---

**First time contributing?** Look for issues labeled `good first issue` on GitHub, or start by improving tests or documentation — both are always welcome.