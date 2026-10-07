# Changelog

All notable changes to this project are documented in this file.

## 2.0.0 - 2026-10-02

### Added

- `serializeError` / `deserializeError` / `AppError.fromJSON` / `ERROR_REGISTRY`,
  so an `AppError` survives a queue, database, or HTTP hop with its class, code,
  status, and nested `cause` intact. A plain `JSON.stringify` round trip
  previously lost all of that and broke `instanceof` on the consumer.
- `getRootCause` and `getErrorChain` for cause-chain traversal, both safe against
  cycles and over-long chains
- `isRetryable` for 408, 425, 429, and 5xx
- `redactDetails`, `DEFAULT_SENSITIVE_KEYS`, and `REDACTED` for masking
  credentials in `details`; wired through `formatError(error, { redact })` and
  the Fastify `redactDetails` option
- `formatError(error, { includeStack, includeCause, redact })`
- `withRetry` options: `maxDelay`, `maxTotalDelay`, `jitter`, `signal`, and
  `onRetry`; `shouldRetry` now defaults to `isRetryable` instead of retrying
  every failure including 4xx
- `withTimeout` and `withRetry` accept a `signal` and reject with the new
  `AbortError`, always instead of the platform `DOMException`
- Result helpers `unwrapOrElse`, `match`, `fold`, `tap`, `collect`,
  `andThenAsync`, `collectAsync`
- `createNotFoundHandler`, and a `Retry-After` header on `RateLimitError`
- Fastify `logOperationalAsWarn` to log 4xx at `warn` and 5xx at `error`
- `test:coverage` and `verify` scripts, coverage thresholds in `vitest.config.ts`,
  and a `.github/workflows/errors.yml` CI workflow
- JSDoc throughout `src`, and README sections covering every export

### Fixed

- `getErrorStatusCode` ignored a status carried by a non-`AppError` error, so a
  Fastify or Axios error was always reported as 500; it now honours `statusCode`
  and `status` when they are in range
- `AppError` accepted impossible status codes (`0`, `-1`, `999`, `NaN`), which
  reached `reply.status()` and threw `FST_ERR_BAD_STATUS_CODE` at response time;
  the constructor now rejects them immediately
- Unmatched routes bypassed the error handler and returned Fastify's default
  404 payload; `registerErrorHandler` and `errorHandlerPlugin` now also install
  `createNotFoundHandler`
- Missing-property schema failures were all bucketed under `required`, losing
  the field names Ajv reports in `params.missingProperty`
- The Fastify handler collapsed unmapped 4xx statuses (malformed JSON bodies,
  405, 418, ...) into `500 INTERNAL_ERROR`
- A throwing `customHandler` replaced the canonical payload with Fastify's
  unstructured fallback, or double-sent an already-replied request
- `NotFoundError` dropped falsy ids (`0`, `""`) from its message and details
- Error `details` could silently overwrite canonical fields such as
  `ValidationError.fields` or `NotFoundError.resource`
- `withTimeout` leaked its timer, keeping the event loop alive after the
  promise settled
- `withRetry` used an async `Promise` executor: a throwing `shouldRetry` left
  the returned promise pending forever and produced an unhandled rejection
- `withRetry` rejected with `undefined` when `maxAttempts` was `NaN`, and could
  retry forever on `Infinity`
- A throwing `errorFactory` made every `tryCatch*` helper and `tryAll` throw or
  reject instead of returning a failed `Result`
- `tryAll` rejected outright when `errorFactory` threw
- `AppError.cause` was an own enumerable property and existed as
  `cause: undefined` when absent; it now uses the standard `Error` cause
  semantics
- `isAppError` missed `AppError` instances from a duplicated copy of the package
- `ERROR_CODES` omitted `UNKNOWN_ERROR`, which `formatError` and `getErrorCode`
  already emit
- README, plugin metadata, and the monorepo doc named the package
  `@bootstrap-framework/errors` instead of `@oneunit/errors`

### Changed

- **Breaking:** `formatValidationError` returns the canonical
  `{ error, timestamp, path, requestId }` payload the handler sends, instead of
  its own flattened shape. `ValidationErrorResponse` is deprecated.
- **Breaking:** `createErrorResponse` returns a `formatError` payload instead of
  its own shape. Deprecated; use `formatError`.
- **Breaking:** `AsyncTryCatchResult` is now an alias of `TryCatchResult` rather
  than a duplicate interface. Deprecated.
- `isAppError` also accepts a structurally compatible `AppError` from another
  copy of the package; Fastify's own errors are still excluded.
- `engines.node` is `>=20.19`, the floor for CommonJS `require` of this ESM-only
  package.
- `withRetry` defaults `shouldRetry` to `isRetryable`, so a 4xx is no longer
  retried by default.

## 1.0.0 - 2026-09-26

### Added

- Typed `AppError` hierarchy for HTTP, database, Kafka, Redis, and WebSocket failures
- `tryCatch`, Result helpers, timeout, and retry utilities
- Optional Fastify error handler
- TypeScript declarations, tests, and npm package metadata

### Changed

- Published independently as `@bootstrap-framework/errors`

### Removed

- Sentry integration that was not implemented in source
