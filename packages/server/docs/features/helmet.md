# Helmet Security Headers

## Overview & Purpose

The **Helmet Plugin** integrates `@fastify/helmet` into `@oneunit/server` to harden HTTP response security by setting standard defensive headers.

It defends your application against common web vulnerabilities:
- **Clickjacking**: via `X-Frame-Options` and CSP `frame-ancestors`.
- **MIME-Type Sniffing**: via `X-Content-Type-Options: nosniff`.
- **Cross-Site Scripting (XSS)**: via `Content-Security-Policy` and `X-XSS-Protection`.
- **Protocol Downgrade**: via `Strict-Transport-Security` (HSTS).
- **Information Leakage**: by hiding server platform headers via `hidePoweredBy`.

---

## Installation & Import Requirements

```typescript
import {
  helmetPlugin,
  type HelmetPluginOptions,
  startServer,
  createServer,
} from "@oneunit/server";

// Alternatively from subpath:
import { helmetPlugin } from "@oneunit/server/plugins";
```

Optional peer dependency:
```bash
npm install @fastify/helmet
```

---

## Configuration Options

When configuring `helmet` in `startServer` or `createServer`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `helmet` | `boolean \| HelmetPluginOptions` | `true` | Enabled by default. Set to `false` to disable. |
| `contentSecurityPolicy` | `boolean \| object` | `true` | Configures `Content-Security-Policy`. Often disabled or customized for APIs. |
| `crossOriginEmbedderPolicy` | `boolean \| object` | `false` | Sets `Cross-Origin-Embedder-Policy`. |
| `crossOriginOpenerPolicy` | `boolean \| object` | `true` | Sets `Cross-Origin-Opener-Policy: same-origin`. |
| `crossOriginResourcePolicy`| `boolean \| object` | `true` | Sets `Cross-Origin-Resource-Policy: same-origin`. |
| `dnsPrefetchControl` | `boolean \| object` | `true` | Sets `X-DNS-Prefetch-Control: off`. |
| `frameguard` | `boolean \| object` | `true` | Sets `X-Frame-Options: SAMEORIGIN`. |
| `hidePoweredBy` | `boolean \| object` | `true` | Removes the `X-Powered-By` header to hide technology stack details. |
| `hsts` | `boolean \| object` | `true` | Sets `Strict-Transport-Security: max-age=15552000; includeSubDomains`. |
| `ieNoOpen` | `boolean \| object` | `true` | Sets `X-Download-Options: noopen` for older IE browsers. |
| `noSniff` | `boolean \| object` | `true` | Sets `X-Content-Type-Options: nosniff`. |
| `referrerPolicy` | `boolean \| object` | `true` | Sets `Referrer-Policy: no-referrer`. |
| `xssFilter` | `boolean \| object` | `true` | Sets `X-XSS-Protection: 0` (modern standard to avoid side-channel leaks). |

---

## Usage Examples

### 1. Default API Server Configuration

For pure JSON REST/GraphQL APIs, disabling Content Security Policy is common because APIs do not render HTML templates:

```typescript
import { startServer } from "@oneunit/server";

const { app } = await startServer({
  serviceName: "core-api",
  helmet: {
    contentSecurityPolicy: false, // Recommended for pure JSON microservices
    frameguard: { action: "deny" },
    hsts: {
      maxAge: 31536000,           // 1 year
      includeSubDomains: true,
      preload: true,
    },
  },
});
```

### 2. Custom Content Security Policy for HTML or Dashboard Endpoints

```typescript
import { createServer } from "@oneunit/server";

const app = await createServer({
  helmet: {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://trusted-cdn.com"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https://images.unsplash.com"],
        connectSrc: ["'self'", "https://api.example.com"],
      },
    },
  },
});
```

---

## Common Use Cases & Best Practices

1. **Disable CSP on Pure APIs**: Setting strict CSP on an API endpoint that only returns JSON can sometimes cause conflicts with interactive API tools like Swagger UI. Disable CSP selectively or configure Swagger UI's `staticCSP` option.
2. **Always Keep `noSniff` and `frameguard`**: These prevent browsers from misinterpreting text/plain as executable JavaScript and protect against iframe clickjacking.
3. **Enable HSTS with Preload in Production**: Ensures that all browser traffic communicates strictly over HTTPS.

---

## Edge Cases & Limitations

- **Peer Dependency Fallback**: If `@fastify/helmet` is missing from `node_modules`, `@oneunit/server` logs a warning and skips plugin registration; routes continue to serve without security headers.
- **Upstream Fastify 5 Compatibility**: `@oneunit/server` declares compatibility with Fastify 5.x and registers helmet using the standard plugin interface.

---

## Related Features

- [CORS](cors.md)
- [Cookies](cookies.md)
- [Swagger UI](swagger-ui.md)
