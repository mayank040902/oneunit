# CSRF Protection

## Overview & Purpose

The **CSRF Protection Plugin** integrates `@fastify/csrf-protection` into `@oneunit/server` to protect state-changing HTTP requests (`POST`, `PUT`, `PATCH`, `DELETE`) against Cross-Site Request Forgery (CSRF).

When web applications rely on browser cookies for authentication, an attacker can trick an authenticated victim into submitting unwanted actions to your server. The CSRF plugin neutralizes this by generating cryptographically secure CSRF tokens and verifying that every state-changing request includes a matching token in request headers or body.

---

## Architecture & How It Works

1. During `GET` requests, the server generates a signed secret stored in an HTTP cookie or session, and exposes a token generator via `reply.generateCsrf()`.
2. The frontend web application includes the generated token in a header (e.g. `x-csrf-token`) or in request bodies.
3. For state-changing requests (`POST`, `PUT`, `DELETE`), the plugin automatically validates the token against the secret before executing the route handler.
4. If the token is missing or invalid, the request is immediately rejected with HTTP `403 Forbidden`.

---

## Installation & Import Requirements

```typescript
import {
  csrfPlugin,
  type CsrfPluginOptions,
  startServer,
  createServer,
} from "@oneunit/server";

// Alternatively from subpath:
import { csrfPlugin } from "@oneunit/server/plugins";
```

Optional peer dependencies:
```bash
npm install @fastify/csrf-protection @fastify/cookie
```

---

## Configuration Options

When configuring `csrf` in `startServer` or `createServer`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `csrf` | `boolean \| CsrfPluginOptions` | `false` | Disabled by default (since pure programmatic APIs often use Bearer tokens). |
| `cookieName` | `string` | `"_csrf"` | Name of the cookie storing the CSRF secret. |
| `cookieOpts` | `object` | `{ path: "/", sameSite: "lax" }` | Cookie flags: `domain`, `path`, `sameSite`, `secure`, `httpOnly`, `signed`. |
| `sessionKey` | `string` | — | Key inside session object if using `@fastify/session` or `@fastify/secure-session`. |
| `sessionPlugin` | `"@fastify/session" \| "@fastify/secure-session" \| false` | `false` | Specifies whether to store secret in session instead of a cookie. |
| `getToken` | `(req: FastifyRequest) => string \| Promise<string>` | — | Custom function to retrieve the token from request (default checks headers and body). |
| `getUserInfo` | `(req: FastifyRequest) => unknown` | — | Custom user-binding for user-specific CSRF tokens. |
| `ignoreMethods` | `string[]` | `["GET", "HEAD", "OPTIONS"]` | Safe HTTP methods exempted from verification. |
| `ignoreRoutes` | `string[]` | `[]` | Route paths completely exempt from CSRF checks (e.g. public webhooks). |
| `skipCheck` | `(req: FastifyRequest) => boolean` | — | Custom predicate to bypass verification dynamically. |

---

## Usage Examples

### 1. Standard Cookie-Based CSRF Protection

```typescript
import { startServer } from "@oneunit/server";

const { app } = await startServer({
  serviceName: "web-portal",
  cookie: {
    secret: "cookie-signing-secret",
  },
  csrf: {
    cookieName: "_csrf",
    cookieOpts: {
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
    ignoreMethods: ["GET", "HEAD", "OPTIONS"],
    ignoreRoutes: ["/api/v1/stripe-webhooks"], // Exclude 3rd-party webhooks
  },
  configure: (server) => {
    // 1. Endpoint for frontend to fetch initial CSRF token
    server.get("/api/csrf-token", async (request, reply) => {
      const token = await reply.generateCsrf();
      return reply.ok({ data: { csrfToken: token } });
    });

    // 2. Protected mutation route
    server.post("/api/transfer-funds", async (request, reply) => {
      // CSRF token is automatically validated before this handler runs!
      return reply.ok({ message: "Funds transferred successfully" });
    });
  },
});
```

---

## Common Use Cases & Best Practices

1. **Exempt Machine-to-Machine Webhooks**: External webhooks (Stripe, GitHub, Shopify) do not originate from browser sessions and will not have CSRF tokens. Always exempt them via `ignoreRoutes: ["/webhooks/stripe"]` and verify their HMAC signatures instead.
2. **Combine with Cookie Secret**: Always configure `cookie.secret` when enabling CSRF so tokens and cookies cannot be spoofed.
3. **Use with Bearer Tokens**: If your API relies exclusively on `Authorization: Bearer <JWT>` stored in memory (and does not use cookies), CSRF protection is generally unnecessary and can remain disabled (`csrf: false`).

---

## Edge Cases & Limitations

- **Peer Dependency Fallback**: If `@fastify/csrf-protection` is missing, `@oneunit/server` logs a warning and proceeds without CSRF checks.
- **Requires Cookie or Session Plugin**: CSRF protection requires either `@fastify/cookie` (default) or a session plugin to persist the secret.

---

## Related Features

- [Cookies](cookies.md)
- [Helmet](helmet.md)
- [CORS](cors.md)
