# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- Optional core helper primitives under `@oneunit/redis/features`: `buildKey`,
  `serialize`, `deserialize`, `jitterTtl`, `setIfAbsent`, `compareAndSwap`,
  `detectCapabilities`, and `createClusterClient`.
- Optional opt-in error-handling profile through `createClient`'s
  `errorHandling` option, plus `classifyError`, `isRetryable`, `attachErrorHandling`,
  `retryOperation`, and `retryOperationWithResult`. Redaction remains mandatory.
- `createScheduledSessionRevocation` for delayed session revocation built on
  BullMQ delayed jobs.
- README documentation for optional feature helpers.


- `runPipeline(client, steps, options?)` batches many commands into a single
  round trip. A failed command does not fail a pipeline — ioredis resolves
  `EXEC` and reports the failure per command — so reading only the values from
  a raw `client.pipeline()` yields `null` for a write that never landed, with
  nothing to distinguish it from a successful one. `runPipeline` returns one
  labelled result per command with an explicit `error`, bounded by a
  `timeout` (default 5s, since ioredis parks queued commands while reconnecting
  and `EXEC` would otherwise never settle), with command errors passed through
  `redactError` — including on a rejected `EXEC`, which skips the per-command
  mapping and would otherwise reach a logger carrying the failing command's
  arguments.

  **Each step must queue exactly one command.** Results are matched to steps by
  position, so a step queuing two commands reports every later value against the
  wrong label, and an `async` step queues nothing before `EXEC` is sent and loses
  its command silently. Neither is a compile error: `PipelineStep.run` is typed as
  returning `void`, and TypeScript permits returning any value from a `void`
  signature, so both type-check cleanly. `runPipeline` reads ioredis's queue
  length around each step and raises `PipelineStepError`, naming the label,
  before anything is sent. Write one step per command, and do not make a step
  `async`.
- `pipelineValues(results)` returns the successful values in order, throwing
  `PipelineCommandError` rather than handing back a sparse array that looks
  complete.
- `PipelineTimeoutError`, `PipelineCommandError`, and `PipelineStepError`. The
  first two messages list step labels only, never command arguments.
- `throwOnError` option on `runPipeline` for batches where a partial write is not
  acceptable.
- `@oneunit/redis/pipeline` subpath export.
- `examples/pipeline.js` and `npm run example:pipeline`.

### Fixed

- `attachQueueEvents().close()` could throw instead of closing cleanly. It
  decides whether a failed close is benign by comparing the error message
  against `"Connection is closed."`, but BullMQ now raises a
  `ConnectionClosedError` whose default message has no trailing period, and
  several of its own code paths pass unrelated wording. Any of those variants
  was rethrown, which is the one outcome the `close()` wrapper exists to
  prevent — and the duplicated connection it could leave behind is one the
  caller has no reference to. The class is now checked structurally; the
  message comparison remains as a fallback.

## 1.0.0 - 2026-10-01

First release under the `@oneunit` name. The `1.0.0` published before it, under
the `@bootstrap-framework` name, is listed under Previous releases.

### Fixed

- `createClient` passed `url` inside the options object, which ioredis ignores,
  so every client silently connected to `localhost:6379`. The URL is now passed
  positionally and falls back to `REDIS_URL`, matching the documented default.
- `createClient` called `connect(url)` when `lazyConnect` was `false`. ioredis
  connects on its own in that mode and `connect()` takes no URL, so the call
  rejected with `Redis is already connecting/connected` and left an unhandled
  rejection.
- `createClient` left `maxRetriesPerRequest` at the ioredis default of `20`.
  BullMQ rejects any connection where it is set, so `createWorker` and
  `attachQueueEvents` could not accept a client from `createClient`. It now
  defaults to `null` and remains overridable.
- `health` had no timeout. ioredis queues commands while reconnecting, so a
  `PING` against an unreachable server never settled and health checks hung
  instead of reporting `down`. Now bounded by `options.timeout` (default
  1000ms).
- `createWorker` forwarded `concurrency: undefined` when the caller omitted it.
  BullMQ only applies its own default for absent keys, so its setter rejected
  the value with `concurrency must be a finite number greater than 0` and the
  worker could not be created at all. `limiter` and `settings` had the same
  latent problem; `createQueue` had it for `settings`.
- `shutdown` threw `Connection is closed.` when called on an already-ended
  client. Applications commonly handle both `SIGINT` and `SIGTERM`, so the
  second signal produced an unhandled rejection during teardown. It is now
  idempotent, and treats a connection that dies mid-`QUIT` as disconnected.
- `attachQueueEvents` defaulted `prefix` to the literal `"queue"` instead of the
  queue's own prefix. BullMQ keys event streams on the prefix, so a queue
  created with a custom prefix received no events and reported no error. The
  queue's prefix is now inherited, with an explicit `prefix` still winning.
- `attachQueueEvents` required a `logger` and threw on the first event when it
  was omitted, unlike every other export in the package. BullMQ swallows the
  listener exception and re-emits it as `error`, so it surfaced as unexplained
  `console.error` output. `logger` is now optional.
- `health` passed a negative or `NaN` timeout straight to `setTimeout`, which
  coerced it to 1ms and emitted a `TimeoutNaNWarning` or
  `TimeoutNegativeWarning` per call. Invalid values now fall back to the default.
- The client `error` event logged its arguments in pino order while every other
  call site used `(message, extra)`.
- Any logger exposing a `child()` method had its arguments swapped into pino's
  `(bindings, message)` order. `child?()` is part of this package's own `Logger`
  interface, so every conforming logger qualified: each record put the message
  in the bindings slot. Loggers are now detected by the `bindings()` method and
  `levels` map a pino instance actually carries, which `child()` loggers inherit.
- `shutdown` could not tell that it had already forced a stalled connection
  closed. `disconnect()` never runs ioredis's `closeHandler` from a client in
  `reconnecting`, so the status stayed `reconnecting` and a second call waited
  out the full 5s QUIT deadline again for a connection that was already gone.
  Applications handling both `SIGINT` and `SIGTERM` paid that twice.
- `attachQueueEvents` and `shutdown` logged errors unredacted, while the client
  event listener already ran them through `redactError`. `QueueEvents` duplicates
  the caller's client and therefore authenticates with the same password, and
  BullMQ re-emits the AUTH failure on its emitter; ioredis attaches the failing
  command to that error, whose `AUTH` args are the password in plaintext. Both
  call sites now redact before logging, so a misconfigured or wrong-password
  server no longer writes the credential to the application's log.
- `createClient("redis://host:port")` ignored the string. ioredis's own
  constructor accepts that form, but destructuring it as an options object
  yielded no `url`, so the client silently connected to `localhost:6379` — the
  wrong server, with no error to notice it by. A string is now accepted and
  treated as the URL.
- `createQueue` spread `defaultJobOptions` over its defaults unconditionally, so
  a key the caller left `undefined` erased the default instead of falling through
  to it. A config assembled by spreading another object
  (`{ ...base, attempts: maybeUndefined }`) silently lost the 3-attempt retry and
  the exponential backoff. The merge is now per key, and `null` still passes
  through, since BullMQ reads `removeOnComplete: null` as "keep the job".
- `examples/queue-worker.js` called `shutdown` without importing it, throwing a
  `ReferenceError` on every Ctrl+C.
- `npm run lint` failed on four errors: a `@ts-ignore` that should have been a
  typed import, two `any` return types, and an unused import.
- The published tarball shipped sourcemaps pointing at a `src/` directory it did
  not include, so consumer stack traces and editor navigation broke silently.
  `src` is now in `files`, matching the auth and logger packages.
- `npm run build` did not clear `dist`, so output from a deleted source file was
  published forever. The build now cleans `dist` first.
- `@oneunit/redis` was imported as `@bootstrap-framework/redis` by the server
  package's redis plugin and declared under the retired name in its
  `package.json`, so `pnpm install --frozen-lockfile` could not resolve it and
  the plugin reported itself disabled instead of naming the actual fault.

### Changed

- `createClient` returns a typed `ioredis` `Redis` instance instead of `any`.
- `createClient` accepts a URL string as its first argument, matching
  `new Redis(url)`.
- `health` accepts an options object and exports `HealthOptions`.
- `attachQueueEvents` accepts an optional `logger`.
- Published as `@oneunit/redis`, renamed from `@bootstrap-framework/redis`.
- The tarball now ships `src`, so the sourcemaps its own `dist` output points at
  resolve in an installed package.

### Added

- `ARCHITECTURE.md` covering module layout, the reasoning behind each default,
  and the trust boundaries around connections, queue names, and logged job data.
- `CONTRIBUTING.md` covering the regression-test rule, the bullmq and ioredis
  default traps in this package, and behaviours that look like bugs but are not.
- Regression tests for every fix above, each verified to fail against the bug it
  covers.
- Tests that need Redis probe for reachability and no-op when none is
  listening, so the suite passes offline.
- A `verify` script running build, typecheck, lint, tests, and `pack:check` in
  order.
- A CI workflow that gates a release on a Node 20/22/24 verify matrix and a
  consumer smoke test that installs the real tarball, exercises both
  `createClient` argument forms, runs a job through a worker, asserts no
  credential reaches the logger, and checks that sourcemap targets and subpath
  exports resolve from the installed package.

## Previous releases

Released as `@bootstrap-framework/redis`.

### 1.0.0 - 2026-09-26

#### Added

- Standalone ioredis client with event logging and shutdown helpers
- BullMQ queue and worker factories
- Built-in console and silent logger adapters
- TypeScript declarations, tests, examples, and npm package metadata

#### Changed

- Published independently as `@bootstrap-framework/redis`
- Logger is injected, not required as a workspace dependency

[Unreleased]: https://github.com/mayank040902/oneunit/compare/redis-v1.0.0...HEAD
[1.0.0]: https://github.com/mayank040902/oneunit/releases/tag/redis-v1.0.0
