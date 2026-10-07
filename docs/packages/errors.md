# @oneunit/errors

Typed error classes, Result helpers, and optional Fastify error handling.

Package README: `packages/errors/README.md`

## Install

```bash
npm install @oneunit/errors
```

## Error classes

All classes extend `AppError` with `code`, `statusCode`, optional `details`, and optional `cause`.

| Class | Status | Code |
| :--- | :--- | :--- |
| `ValidationError` | 400 | `VALIDATION_ERROR` |
| `BadRequestError` | 400 | `BAD_REQUEST` |
| `AuthenticationError` | 401 | `AUTHENTICATION_ERROR` |
| `AuthorizationError` | 403 | `AUTHORIZATION_ERROR` |
| `NotFoundError` | 404 | `NOT_FOUND` |
| `ConflictError` | 409 | `CONFLICT` |
| `RateLimitError` | 429 | `RATE_LIMIT_EXCEEDED` |
| `InternalError` | 500 | `INTERNAL_ERROR` |
| `DatabaseError` | 500 | `DATABASE_ERROR` |
| `KafkaError` | 500 | `KAFKA_ERROR` |
| `RedisError` | 500 | `REDIS_ERROR` |
| `WebSocketError` | 500 | `WEBSOCKET_ERROR` |
| `ConnectionError` | 503 | `CONNECTION_ERROR` |
| `TimeoutError` | 504 | `TIMEOUT` |
| `UnprocessableError` | 422 | `UNPROCESSABLE_ENTITY` |
| `PayloadTooLargeError` | 413 | `PAYLOAD_TOO_LARGE` |
| `UnsupportedMediaTypeError` | 415 | `UNSUPPORTED_MEDIA_TYPE` |
| `ServiceUnavailableError` | 503 | `SERVICE_UNAVAILABLE` |
| `ExternalServiceError` | 502 | `EXTERNAL_SERVICE_ERROR` |
| `ConfigurationError` | 500 | `CONFIGURATION_ERROR` |
| `EncryptionError` | 500 | `ENCRYPTION_ERROR` |
| `SerializationError` | 400 | `SERIALIZATION_ERROR` |

## Result helpers

`tryCatch`, `tryCatchAsync`, `tryCatchSync`, `tryCatchPromise`, `tryCatchResult`,
`toAppError`, `ok`, `err`, `isOk`, `isErr`, `unwrap`, `unwrapOr`, `unwrapOrElse`,
`match`, `fold`, `map`, `mapErr`, `andThen`, `andThenAsync`, `orElse`, `tap`,
`collect`, `collectAsync`, `combine`, `tryAll`, `assertNever`, `unreachable`,
`withTimeout`, `withRetry`, `AbortError`.

`isAppError`, `isOperationalError`, `isRetryable`, `isErrorCode`,
`getErrorStatusCode`, `getErrorCode`, `getRootCause`, `getErrorChain`,
`formatError`, `redactDetails`, `serializeError`, `deserializeError`,
`ERROR_REGISTRY`, `ERROR_CODES`.

## Serialization, redaction, and cancellation

`serializeError` / `deserializeError` carry an error across a queue, database,
or HTTP hop with its class, code, status, and `cause` chain intact - a plain
`JSON.parse(JSON.stringify(error))` loses all of that.

`formatError(error, { includeStack, includeCause, redact })` and the Fastify
`redactDetails` option mask sensitive keys in `details`; `DEFAULT_SENSITIVE_KEYS`
lists them and `REDACTED` is the replacement value.

`withRetry` accepts `maxAttempts`, `delay`, `backoff`, `maxDelay`,
`maxTotalDelay`, `jitter`, `shouldRetry`, `signal`, and `onRetry`, and defaults
`shouldRetry` to `isRetryable`. `withTimeout` and `withRetry` reject with
`AbortError` when their `signal` fires.

## Fastify

```javascript
import { registerErrorHandler } from "@oneunit/errors";

await registerErrorHandler(app, {
    logErrors: true,
    includeStack: false,
    logOperationalAsWarn: true,
    redactDetails: true,
});
```

Note: the server package's errors plugin still imports the old
`@bootstrap-framework/errors/fastify` specifier and downgrades the failure to a
warning, so this registration is currently manual.
