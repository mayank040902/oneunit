# @oneunit/errors

Typed error classes, Result helpers, and optional Fastify error handling.

- **Zero runtime dependencies.** One optional peer (`fastify`), imported as a
  type only — importing this package never loads Fastify.
- **75 exports** across three layers you can import independently:
  `@oneunit/errors/errors`, `/try-catch`, and `/fastify`.
- **One canonical error payload** for HTTP responses, one wire format for
  cross-process errors, and redaction for anything that might carry a secret.

Monorepo: https://github.com/mayank040902/oneunit

## Docs

- [ARCHITECTURE.md](./ARCHITECTURE.md) — design rationale, the status ladder,
  deliberate behaviors, known limitations
- [CHANGELOG.md](./CHANGELOG.md) — release history and migration notes
- [CONTRIBUTING.md](./CONTRIBUTING.md) — how to contribute, and what not to
  "fix"

## Install

```bash
npm install @oneunit/errors
```

Requires **Node.js 20.19+** (CommonJS consumers need `require(esm)` support).
Fastify is an optional peer.

## Quick start

```javascript
import { AppError, NotFoundError, tryCatchAsync } from "@oneunit/errors";

throw new NotFoundError("User", "42");

const { data, error } = await tryCatchAsync(loadUser("42"));
if (error) {
    throw error;
}
```

Branch on `code`, not on `statusCode` — `code` is the stable contract, and it is
what survives a network hop:

```javascript
import { getErrorCode, isOperationalError, isRetryable } from "@oneunit/errors";

getErrorCode(error);        // "NOT_FOUND"
isOperationalError(error);  // true — the caller's fault
isRetryable(error);         // false — a retry cannot fix a 404
```

## Error classes

All classes extend `AppError` with `code`, `statusCode`, optional `details`, and optional `cause`. This is the complete list, ordered by status.

| Class | Status | Code |
| :--- | :--- | :--- |
| `ValidationError` | 400 | `VALIDATION_ERROR` |
| `BadRequestError` | 400 | `BAD_REQUEST` |
| `SerializationError` | 400 | `SERIALIZATION_ERROR` |
| `AuthenticationError` | 401 | `AUTHENTICATION_ERROR` |
| `AuthorizationError` | 403 | `AUTHORIZATION_ERROR` |
| `NotFoundError` | 404 | `NOT_FOUND` |
| `ConflictError` | 409 | `CONFLICT` |
| `PayloadTooLargeError` | 413 | `PAYLOAD_TOO_LARGE` |
| `UnsupportedMediaTypeError` | 415 | `UNSUPPORTED_MEDIA_TYPE` |
| `UnprocessableError` | 422 | `UNPROCESSABLE_ENTITY` |
| `RateLimitError` | 429 | `RATE_LIMIT_EXCEEDED` |
| `InternalError` | 500 | `INTERNAL_ERROR` |
| `ConfigurationError` | 500 | `CONFIGURATION_ERROR` |
| `DatabaseError` | 500 | `DATABASE_ERROR` |
| `KafkaError` | 500 | `KAFKA_ERROR` |
| `RedisError` | 500 | `REDIS_ERROR` |
| `WebSocketError` | 500 | `WEBSOCKET_ERROR` |
| `EncryptionError` | 500 | `ENCRYPTION_ERROR` |
| `ExternalServiceError` | 502 | `EXTERNAL_SERVICE_ERROR` |
| `ConnectionError` | 503 | `CONNECTION_ERROR` |
| `ServiceUnavailableError` | 503 | `SERVICE_UNAVAILABLE` |
| `TimeoutError` | 504 | `TIMEOUT` |

`AppError` itself is exported for codes the table does not cover. It validates
`statusCode` on construction: anything outside 100–599 throws a `RangeError`
immediately rather than failing later inside `reply.status()`.

The list is deliberately not exhaustive — it grows from real reports. To add
one, see [CONTRIBUTING.md](./CONTRIBUTING.md#adding-an-error-class).

```javascript
import { AppError, NotFoundError, ConflictError } from "@oneunit/errors";

throw new NotFoundError("User", "42");
throw new ConflictError("Email already exists", { field: "email" });
throw new AppError("Something went wrong", "CUSTOM_ERROR", 500, { service: "kafka" });
```

Subclasses take arguments ordered so the useful ones come first — a
`NotFoundError` needs a resource and an id, a `DatabaseError` needs the query.
Caller-supplied `details` are spread *before* the class's own fields, so they
can never overwrite `resource`, `fields`, or `id`.

## Result helpers

```javascript
import { tryCatch, tryCatchAsync, ok, err, unwrap } from "@oneunit/errors";

const { data, error } = tryCatch(() => JSON.parse(raw));
const result = await tryCatchAsync(fetchUser(id));
```

| Export | Description |
| :--- | :--- |
| `tryCatch(fn, factory?)` | Runs `fn`, returns `{ data, error }` |
| `tryCatchAsync(promise, factory?)` | The same for a promise |
| `tryCatchSync(fn, options?)` | Returns the value or `null`, with an `onError` callback |
| `tryCatchPromise(promise, options?)` | The async form of `tryCatchSync` |
| `tryCatchResult(promise, factory?)` | Resolves to a `Result` |
| `toAppError(error)` | Normalizes any thrown value to an `AppError` |
| `ok(value)` / `err(error)` | Build a `Result` |
| `isOk` / `isErr` | Narrow a `Result` |
| `unwrap` / `unwrapOr` / `unwrapOrElse` | Extract the value, with or without a fallback |
| `match` / `fold` | Fold both branches into one value |
| `map` / `mapErr` | Transform one side of a `Result` |
| `andThen` / `andThenAsync` | Chain a `Result` |
| `orElse` | Recover from a failed `Result` |
| `tap` | Side effect on success |
| `collect` / `collectAsync` | Short-circuit on the first error |
| `combine` / `tryAll` | Combine results, or settle promises into results |
| `assertNever` / `unreachable` | Exhaustiveness helpers |
| `withTimeout(promise, ms, message?, { signal })` | Reject with `TimeoutError` after `ms` |
| `withRetry(fn, options)` | Retry with backoff (see below) |
| `AbortError` | Rejection reason for an aborted retry or timeout |

`withRetry` accepts `maxAttempts`, `delay`, `backoff`, `maxDelay`,
`maxTotalDelay`, `jitter`, `shouldRetry`, `signal`, and `onRetry`. It defaults
`shouldRetry` to `isRetryable`, so a 4xx is not retried while a 5xx is.

```javascript
const data = await withRetry(fetchProfile, {
    maxAttempts: 4,
    delay: 200,
    maxTotalDelay: 2000,
    jitter: true,
    signal: shutdown.signal,
    onRetry: (error, attempt, delayMs) => metrics.increment("retry", { attempt, delayMs }),
});
```

## Serializing errors across a boundary

An `AppError` does not survive `JSON.stringify` on its own - it comes back as a
plain object, so `instanceof` fails on the consumer. `serializeError` and
`deserializeError` carry the class, code, status, and `cause` chain across a
queue, database, or HTTP hop.

```javascript
import { serializeError, deserializeError, AppError } from "@oneunit/errors";

// Producer
await queue.send(JSON.stringify(serializeError(error, { includeStack: true })));

// Consumer
const error = deserializeError(JSON.parse(message));
if (error) throw error; // instanceof AppError again
```

`deserializeError` rebuilds any class in `ERROR_REGISTRY`; an unregistered code
becomes a plain `Error` that still carries `code`, `statusCode`, and `details`.

## Inspecting and redacting

```javascript
import { getRootCause, getErrorChain, formatError, redactDetails } from "@oneunit/errors";

getRootCause(error);            // deepest cause
getErrorChain(error);           // [error, ...causes]

formatError(error, {
    includeStack: false,        // omit internals from the payload
    includeCause: true,         // append the cause chain
    redact: true,               // mask password/token/apikey/... in details
});
```

`DEFAULT_SENSITIVE_KEYS` lists the masked keys, `REDACTED` is the replacement
value, and `redactDetails(details, keys)` masks a record directly. Redaction is
off by default so existing payloads are unchanged - turn it on wherever
`details` may carry credentials.

## Fastify

```javascript
import Fastify from "fastify";
import { registerErrorHandler } from "@oneunit/errors";

const app = Fastify();
await registerErrorHandler(app, {
    logErrors: true,
    includeStack: false,
    logOperationalAsWarn: true,
    redactDetails: true,
});
```

`registerErrorHandler` (and the `errorHandlerPlugin` plugin) also installs a
not-found handler, so unmatched routes return the same payload shape as every
other error instead of Fastify's built-in `{ message, error, statusCode }`.

| Option | Default | Description |
| :--- | :--- | :--- |
| `includeStack` | `false` | Include `stack` in the response |
| `logErrors` | `true` | Log every error |
| `logOperationalAsWarn` | `false` | Log 4xx at `warn`, 5xx at `error` |
| `redactDetails` | `false` | Mask sensitive keys in `details` |
| `customHandler` | - | Replace the default response entirely |

| Export | Description |
| :--- | :--- |
| `createErrorHandler(options?)` | Fastify error handler |
| `createNotFoundHandler(options?)` | Fastify 404 handler |
| `registerErrorHandler(app, options?)` | Registers both handlers |
| `errorHandlerPlugin` | The same, as a Fastify plugin |
| `formatValidationError(error, request, options?)` | Canonical payload for a validation failure |
| `ERROR_CODES` / `ErrorCode` / `isErrorCode` | Stable machine-readable codes |

A `RateLimitError` carrying a `retryAfter` is sent with a `Retry-After`
response header, rounded up to whole seconds.

The handler maps an unrecognized error by status: Ajv schema failures become a
`ValidationError` keyed by field path, then 401/403/404/409/413/415/422/429/503/504
map to their classes, any remaining 5xx becomes an `InternalError`, and **any
remaining 4xx keeps its own status** with the code `BAD_REQUEST` — so a
malformed JSON body answers 400 rather than 500. See
[ARCHITECTURE.md](./ARCHITECTURE.md#the-status-ladder).

Register the handler at the root of your app. Registering it inside a nested
`app.register(async (child) => …)` scopes it to that child, which is Fastify's
normal encapsulation rule.

```javascript
await app.register(errorHandlerPlugin, { includeStack: false });
```

## Type guards and accessors

| Export | Description |
| :--- | :--- |
| `isAppError(error)` | Type guard; also accepts a copy of this package from another install |
| `isOperationalError(error)` | 4xx, i.e. the caller's fault |
| `isRetryable(error)` | Worth retrying: 408, 425, 429, 5xx |
| `getErrorStatusCode(error)` | Status, honouring a foreign error's own `statusCode`/`status` |
| `getErrorCode(error)` | Stable code, falling back to `INTERNAL_ERROR`/`UNKNOWN_ERROR` |
| `getRootCause(error)` | The deepest error in the `cause` chain |
| `getErrorChain(error)` | The whole chain, nearest first |
| `formatError(error, options?)` | Canonical JSON payload |
| `redactDetails(details, keys?)` | Mask sensitive keys in a record |
| `serializeError(error, options?)` / `deserializeError(payload)` | Cross a process boundary |
| `ERROR_REGISTRY` | Every error class keyed by its code |

## Things worth knowing

These are deliberate and documented in
[ARCHITECTURE.md](./ARCHITECTURE.md#deliberate-behaviors) — they read like bugs,
so they are collected here rather than left to be discovered:

- `JSON.stringify(error)` includes `stack` and does **not** redact `details`. Use
  `formatError(error, { redact: true, includeStack: false })`, or the Fastify
  `redactDetails` option, anywhere the output is not a trusted local log.
- Redaction matches key *names*. A secret inside a raw SQL string in
  `DatabaseError.query` is not masked.
- `withTimeout` stops waiting; it does not cancel the underlying work.
- `unwrap(err(x))` throws `x`, which may not be an `Error`.
- `combine` and `tryAll` do not fail fast — the error you get is the first
  failure in argument order.

## License

MIT. Copyright (c) 2026 mayank.
