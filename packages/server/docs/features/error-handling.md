# Global Error Handling

## Overview & Purpose

The **Global Error Handler** plugin intercepts all uncaught errors, Fastify schema validation failures, and missing 404 routes, transforming them into canonical, structured JSON responses.

Key capabilities:
- **Centralized Normalization**: Converts raw JavaScript errors, HTTP exceptions, and domain errors into consistent platform error responses.
- **Environment-Safe Stack Traces**: By default, stack traces are stripped (`includeStack: false`) to avoid leaking sensitive internal implementation details or server paths in production.
- **Intelligent Logging Levels**: Distinguishes between operational client errors (HTTP 4xx, logged at `warn` level with `logOperationalAsWarn: true`) and critical server faults (HTTP 5xx, logged at `error` level).
- **Sensitive Data Redaction**: Automatically sanitizes sensitive keys (passwords, tokens, secrets) in error details via `redactDetails`.
- **Graceful Fallback**: If the optional peer package `@oneunit/errors` is not installed, it logs a warning and preserves Fastify's native error handler without crashing.

---

## Architecture & How It Works

```
Route Throws Error / Validation Fails / 404 Route Not Found
  │
  ▼
[Fastify Error Handler]
  │
  ├─ Custom Handler provided? ──► Calls customHandler(error, req, reply)
  │                               (Can handle or delegate)
  │
  ▼
Determine Error Type:
  ├─ Fastify Schema Validation Error:
  │    Extracts field violations, formats errors array, sets HTTP 400/422
  │
  ├─ Rate Limit Reached (429):
  │    Extracts retry metadata and sets `Retry-After` header
  │
  ├─ Known Platform/HTTP Error:
  │    Extracts statusCode, message, and error code
  │
  └─ Unhandled Exception:
       Masks as HTTP 500 "Internal Server Error", logs stack trace
  │
  ▼
Apply Sanitization & Redaction (redactDetails, detailLimits)
  │
  ▼
Send Canonical JSON Response
```

---

## Installation & Import Requirements

```typescript
import {
  errorHandlerPlugin,
  type ErrorHandlerPluginOptions,
} from "@oneunit/server";

// Alternatively from subpath:
import { errorHandlerPlugin } from "@oneunit/server/plugins";
```

Optional peer dependency: `@oneunit/errors` (specifically `@oneunit/errors/fastify`).

```bash
npm install @oneunit/errors
```

---

## Configuration Options

When configuring `errorHandler` in `startServer` or `createServer`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `includeStack` | `boolean` | `false` | When true, includes the `stack` trace in the response body. Recommended only in local development. |
| `logErrors` | `boolean` | `true` | Log all caught errors to Fastify's structured logger. |
| `logOperationalAsWarn` | `boolean` | `false` | When true, logs 4xx operational errors at `warn` level instead of `error` level, keeping production error alerts clean. |
| `redactDetails` | `boolean \| readonly string[]` | `false` | Masks sensitive keys (e.g. `password`, `token`, `secret`, `authorization`) in error details before sending. |
| `detailLimits` | `object` | `{}` | Bounds on size of `details`: `maxKeys`, `maxDepth`, `maxStringLength`. Protects against log bloat. |
| `includeAggregated` | `boolean` | `true` | When handling `AggregateError`, includes all sub-errors in the response. |
| `customHandler` | `(err, req, reply) => Promise<void>` | — | Custom function to intercept and handle specific error types before default handling. |

To disable the error handler plugin:
```typescript
const app = await createServer({ errorHandler: false });
```

---

## Usage Examples

### 1. Production Configuration with Redaction and Clean Logs

```typescript
import { startServer } from "@oneunit/server";

const { app } = await startServer({
  serviceName: "identity-api",
  errorHandler: {
    includeStack: process.env.NODE_ENV === "development",
    logErrors: true,
    logOperationalAsWarn: true, // 404s and 400s won't trigger PagerDuty alerts
    redactDetails: ["password", "apiKey", "refreshToken"],
    detailLimits: {
      maxDepth: 3,
      maxStringLength: 500,
    },
  },
});
```

### 2. Custom Error Transformation

```typescript
import { createServer } from "@oneunit/server";

class DomainValidationError extends Error {
  constructor(public fields: Record<string, string>) {
    super("Domain validation failed");
    this.name = "DomainValidationError";
  }
}

const app = await createServer({
  errorHandler: {
    customHandler: async (error, request, reply) => {
      if (error instanceof DomainValidationError) {
        return reply.badRequest({
          message: error.message,
          errors: Object.entries(error.fields).map(([field, message]) => ({
            field,
            message,
          })),
        });
      }
      // Return without replying to let the standard error handler handle other errors
    },
  },
  configure: (server) => {
    server.post("/account", async () => {
      throw new DomainValidationError({ username: "Username is already taken" });
    });
  },
});
```

---

## Common Use Cases & Best Practices

1. **Keep `includeStack: false` in Production**: Stack traces reveal file paths, package versions, and line numbers that attackers can use to find known vulnerabilities.
2. **Use `logOperationalAsWarn: true`**: Differentiate between expected client validation mistakes (e.g. invalid email submitted, 404 page requested) and unexpected server crashes (e.g. database query timeout, unhandled null reference).
3. **Handle Rate Limiting Retries**: The global error handler automatically forwards `Retry-After` headers when 429 Too Many Requests errors occur.

---

## Edge Cases & Limitations

- **Peer Dependency Fallback**: If `@oneunit/errors` is not installed, `@oneunit/server` logs:
  `"errors package not installed, using default Fastify error handler"`
  and preserves Fastify's standard JSON error payload `{ statusCode, error, message }`.
- **Response Already Sent**: If an error is thrown after headers or payload chunks have already been flushed to the network socket, the error handler avoids writing headers again to prevent `ERR_HTTP_HEADERS_SENT`.

---

## Related Features

- [Response Management](response-management.md)
- [Logging](logging.md)
- [Data Validation with Zod](data-validation.md)
