# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Database replication: `ReplicationConfig` option on `CreateDatabaseOptions` for primary / read-replica routing (non-sharded) and `ShardConfig.replication` for per-shard replication
- `ReplicationApi` on `Database` with `health()`, `endpointHealth(id)`, `readEndpoint(preference)`, `primaryPool`, `shutdown()`
- `ReplicationManager` — primary pool plus zero or more replica pools per logical database/shard, with lifecycle, health tracking, and runtime add/remove replica
- `ReplicationRouter` — read-preference routing (`primary` / `replica-preferred` / `replica-only`) with explicit fallback; writes always target the primary
- Replication-aware `db.query()` read preference (`QueryOptions.readPreference`) — default `"primary"` preserves existing behavior
- Types: `ReplicationConfig`, `ReplicationMode`, `ReadPreference`, `ReplicationEndpointConfig`, `ReplicationEndpointHealth`, `ReplicationHealthResult`, `ReplicationApi`, `ShardReplicationConfig`
- Errors: `ReplicationConfigError`, `ReplicaUnavailableError`, `PrimaryUnavailableError`, `WriteToReplicaError`, `ReadPreferenceError`
- Replication lag measurement (`pg_last_xact_replay_timestamp`) with unknown-vs-zero-lag distinction and configurable `lagThresholdMs`
- Per-endpoint health integrated with shard health reporting (role, status, latency, lag, failures, sanitized errors)
- Config validation: duplicate endpoint IDs, invalid pool settings, missing primary, invalid read preference, invalid lag threshold

- `idleTransactionTimeout` option on `DatabaseConfig` / `CreateDatabaseOptions` for configuring PostgreSQL's `idle_in_transaction_session_timeout` per connection
- `IdleTransactionTimeout` type exported from package entry points
- Validation for `idleTransactionTimeout` (rejects negative, zero, `NaN`, `Infinity`, and values exceeding 2,147,483,647 ms)
- Database sharding: `ShardingConfig` option on `CreateDatabaseOptions` for multi-database routing
- `ShardingApi` on `Database` with `query(shardKey, ...)`, `transaction(shardKey, ...)`, `getShardForKey(key)`, `getShard(id)`, `shutdown()`
- `ShardManager` — one `pg.Pool` per shard with lifecycle management
- `ShardRouter` — resolves shard keys to shards via configurable strategies
- Nine routing strategies:
  - `hash` — FNV-1a hash with modulo routing (deterministic)
  - `consistent-hash` — Hash ring with virtual nodes (minimal remapping)
  - `rendezvous` — Highest random weight hashing
  - `range` — Ordered key range routing
  - `directory` — Explicit key-to-shard mapping
  - `tenant` — Multi-tenant shard placement
  - `composite` — Multi-component key routing
  - `geographic` — Region-aware shard selection
  - `weighted` — Weighted placement by capacity
- `ShardNotFoundError`, `ShardingDisabledError`, `ShardConfigError`, `CrossShardTransactionError`
- Types: `ShardingConfig`, `ShardConfig`, `WeightedShardConfig`, `ShardRange`, `ShardStrategyName`, `ShardingApi`, `ShardInfo`, `ShardRoutingContext`, `ShardStrategy`
- `getRegisteredStrategyNames()` for discovering available strategies
- Strategy validation during initialization

### Changed

- `db.query()` and `db.transaction()` now transparently route to shards when sharding is enabled, using `shardKey` in options
- `ShardingConfig` is now a discriminated union keyed by `strategy` (legacy flat config still accepted)
- `ShardStrategy` interface now includes `validate()` method and `version` property
- `db.sharding.query()` / `db.sharding.transaction()` kept as deprecated compatibility wrappers

### Changed

- `db.sharding.health()` and `db.sharding.shardHealth(id)` added for per-shard observability
- `ShardInfo` now includes `consecutiveFailures`, `lastError`, `lastCheckedAt`
- `ShardManager` tracks per-shard failure state (recorded on pool errors and health check failures)

### Added

- CA certificate support for shard connections via `ssl.ca` in shard connection config
- CA certificate contents are never logged — SSL presence only
- `ShardMapVersion` and `routingVersion` for tracking shard map changes
- `ShardManager.addShard()` and `ShardManager.removeShard()` for runtime shard management
- `ReshardingHooks` with `onBeforeReshard` and `onAfterReshard` callbacks
- `ShardMigrationTracker` for cross-shard migration coordination
- `db.sharding.migrate.runMigrationOnAllShards()` — run SQL migrations across all shards
- `db.sharding.migrate.getMigrationStatus()` — per-migration status across shards
- `db.sharding.migrate.getShardMigrationStatus()` — per-shard migration history
- `db.sharding.migrate.getMigrationStats()` — aggregate migration statistics
- `ShardMigrationTracker` and `MigrationStatus` types exported
- Integration tests against real PostgreSQL (`test/sharding/integration.test.js`)

## [1.0.0] - 2026-09-28

### Added

- Centralized environment configuration via `loadDatabaseConfig()`
- Opt-in retries for genuinely transient PostgreSQL errors
- Query timeouts, prepared statements, and `queryOne()`
- Transaction isolation, read-only mode, statement timeout, and savepoint validation
- Streaming and cursor release guarantees, plus async iteration on cursors
- Batch inserts with automatic chunking and `ON CONFLICT` support
- Lightweight SQL tagged template and query builder
- Model helpers for common CRUD
- File and in-memory migration runner
- Normalized `DatabaseError` and `TimeoutError`
- Optional logging and metrics hooks (parameters are never logged by default)
- Health check payload suitable for readiness endpoints
- Idempotent graceful pool shutdown
- JSON serialization utilities (`encode`, `decode`, `serializeRow`, etc.)

### Fixed

- `client.query(sql, options)` ambiguous signature — options object now correctly distinguished from values array
- `parseSslConfig()` silent CA file failure — now warns and forces `rejectUnauthorized: false` when CA file missing
- QueryBuilder conflict handling — `id` column filtered from `ON CONFLICT ... DO UPDATE SET` when specified
- SQL template edge cases — empty arrays in `IN` clauses now produce `FALSE` instead of `NULL`
- `whereRaw()` placeholder replacement — now correctly maps values by position index
- `where(undefined)` and `orWhere(undefined)` — now correctly convert to `IS NULL`
- `msgpack` module renamed to `json-serialization` (uses JSON, not MessagePack format)

### Changed

- Package renamed from `@bootstrap-framework/database` to `@oneunit/database`
- `@oneunit/database` is now a standalone npm package with no `workspace:*` runtime dependencies
- Row serialization helpers no longer depend on an external msgpack package

### Removed

- Runtime dependency on a workspace msgpack package

### Security

- CA file path validation in `parseSslConfig()` prevents silent fallback to unverified SSL
