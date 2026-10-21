# Cross-Origin Resource Sharing (CORS)

## Overview & Purpose

The **CORS Plugin** configures Cross-Origin Resource Sharing headers for `@oneunit/server` using `@fastify/cors`.

By default, `@oneunit/server` enables CORS with `{ origin: true, credentials: true }`, allowing local frontend development across ports (e.g. Next.js on port 3000 calling Fastify on port 8080) with cookie support enabled out of the box. For production deployments, it provides a full suite of options for restricting allowed origins, HTTP methods, headers, and preflight caches.

---

## Installation & Import Requirements

```typescript
import {
  corsPlugin,
  type CorsPluginOptions,
  startServer,
  createServer,
} from "@oneunit/server";

// Alternatively from subpath:
import { corsPlugin } from "@oneunit/server/plugins";
```

Optional peer dependency:
```bash
npm install @fastify/cors
```

---

## Configuration Options

When configuring `cors` in `startServer` or `createServer`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `origin` | `boolean \| string \| string[] \| Function` | `true` | Allowed origins. Set to string, array of domains, regex, or a custom validation callback. |
| `credentials` | `boolean` | `true` | Sets `Access-Control-Allow-Credentials`. Necessary for cookies and authorization headers. |
| `methods` | `string[]` | Fastify defaults | Allowed HTTP verbs (e.g. `["GET", "POST", "PUT", "DELETE", "PATCH"]`). |
| `allowedHeaders` | `string[]` | Fastify defaults | Configures `Access-Control-Allow-Headers`. |
| `exposedHeaders` | `string[]` | `[]` | Configures `Access-Control-Expose-Headers` (e.g. `["x-request-id", "content-disposition"]`). |
| `maxAge` | `number` | — | Configures `Access-Control-Max-Age` (in seconds) to cache preflight OPTIONS responses. |
| `preflightContinue`| `boolean` | `false` | Passes preflight OPTIONS requests to subsequent handlers instead of replying immediately. |
| `optionsSuccessStatus` | `number` | `204` | Status code returned on successful preflight OPTIONS requests. |

To disable CORS completely:
```typescript
const app = await createServer({ cors: false });
```

---

## Usage Examples

### 1. Production Domain Whitelisting with Credentials

```typescript
import { startServer } from "@oneunit/server";

const { app } = await startServer({
  serviceName: "customer-api",
  cors: {
    origin: [
      "https://example.com",
      "https://admin.example.com",
      "https://checkout.example.com",
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Trace-Id", "X-Device-Id"],
    exposedHeaders: ["X-Request-Id", "Content-Disposition"],
    maxAge: 86400, // Cache preflight requests for 24 hours
  },
});
```

### 2. Dynamic Origin Validation Callback

```typescript
import { createServer } from "@oneunit/server";

const app = await createServer({
  cors: {
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl)
      if (!origin) return callback(null, true);

      const hostname = new URL(origin).hostname;
      // Allow any subdomain of internal.company.com
      if (hostname.endsWith(".internal.company.com") || hostname === "localhost") {
        callback(null, true);
      } else {
        callback(new Error("Origin not allowed by CORS"), false);
      }
    },
    credentials: true,
  },
});
```

---

## Common Use Cases & Best Practices

1. **Never Use Wildcard `*` with Credentials**: The CORS specification forbids `Access-Control-Allow-Origin: *` when `Access-Control-Allow-Credentials: true`. `@oneunit/server` automatically echoes the incoming request origin when `origin: true` is configured.
2. **Set `maxAge` for Performance**: Setting `maxAge: 86400` eliminates unnecessary preflight `OPTIONS` requests from web browsers, cutting network round trips in half.
3. **Expose Custom Headers**: If your frontend needs to read `X-Request-Id` or download filenames from `Content-Disposition`, you must explicitly list them in `exposedHeaders`.

---

## Edge Cases & Limitations

- **Peer Dependency Fallback**: If `@fastify/cors` is missing from `node_modules`, `@oneunit/server` logs a warning and proceeds without adding CORS headers.
- **Preflight Routing**: Standard preflight `OPTIONS` requests are handled automatically before route handlers execute unless `preflightContinue: true` is enabled.

---

## Related Features

- [Security Headers (Helmet)](helmet.md)
- [Cookies](cookies.md)
- [CSRF Protection](csrf-protection.md)
