# Cookies

## Overview & Purpose

The **Cookie Plugin** integrates `@fastify/cookie` into `@oneunit/server`, providing:
- Automated parsing of inbound `Cookie` HTTP request headers onto `request.cookies`.
- Cryptographic cookie signing and tampering detection using HMAC secrets.
- `reply.setCookie()` and `reply.clearCookie()` methods on Fastify replies.
- Pre-configured security presets (`authCookieOptions`, `accessCookieOptions`, `refreshCookieOptions`) that automatically enforce `httpOnly: true`, `sameSite: "lax"`, and conditional `secure: isProduction()`.

---

## Installation & Import Requirements

```typescript
import {
  cookiePlugin,
  authCookieOptions,
  accessCookieOptions,
  refreshCookieOptions,
  type CookiePluginOptions,
  startServer,
  createServer,
} from "@oneunit/server";

// Alternatively from subpaths:
import { cookiePlugin } from "@oneunit/server/plugins";
import { authCookieOptions, refreshCookieOptions } from "@oneunit/server/lib";
```

Optional peer dependency:
```bash
npm install @fastify/cookie
```

---

## Configuration Options

When configuring `cookie` in `startServer` or `createServer`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `cookie` | `boolean \| CookiePluginOptions` | `true` | Enabled by default. Set to `false` to disable. |
| `secret` | `string \| string[]` | — | Secret string (or array of rotated secrets) used to sign and verify cookies. |
| `hook` | `"onRequest" \| "preHandler"` | `"onRequest"` | Fastify lifecycle hook where cookie parsing takes place. |
| `parseOptions` | `object` | `{}` | Upstream options passed to cookie parser. |

---

## Pre-Configured Cookie Presets

`@oneunit/server/lib` exports 3 production-hardened cookie configurations:

```typescript
export const authCookieOptions = {
  httpOnly: true,
  secure: isProduction(),
  sameSite: "lax" as const,
  path: "/",
  maxAge: 7 * 24 * 60 * 60, // 7 days (in seconds)
};

export const accessCookieOptions = {
  httpOnly: true,
  secure: isProduction(),
  sameSite: "lax" as const,
  path: "/",
  maxAge: 15 * 60, // 15 minutes (in seconds)
};

export const refreshCookieOptions = {
  httpOnly: true,
  secure: isProduction(),
  sameSite: "lax" as const,
  path: "/",
  maxAge: 30 * 24 * 60 * 60, // 30 days (in seconds)
};
```

---

## Usage Examples

### 1. Signing and Setting Authentication Cookies

```typescript
import { startServer, authCookieOptions } from "@oneunit/server";

const { app } = await startServer({
  serviceName: "auth-api",
  cookie: {
    secret: "super-secure-encryption-and-signing-secret",
  },
  configure: (server) => {
    // Setting a signed cookie
    server.post("/login", async (request, reply) => {
      const sessionToken = await authenticateUser(request.body);

      reply.setCookie("sessionId", sessionToken, {
        ...authCookieOptions,
        signed: true, // Signs cookie with the configured secret
      });

      return reply.ok({ message: "Authenticated successfully" });
    });

    // Reading a signed cookie
    server.get("/me", async (request, reply) => {
      // Unsigned cookies: request.cookies[name]
      // Signed cookies: request.unsignCookie(request.cookies.sessionId)
      const rawCookie = request.cookies.sessionId;
      if (!rawCookie) {
        return reply.unauthorized({ message: "No session cookie found" });
      }

      const unsigned = request.unsignCookie(rawCookie);
      if (!unsigned.valid) {
        return reply.unauthorized({ message: "Session cookie signature invalid or tampered" });
      }

      const user = await lookupSession(unsigned.value);
      return reply.ok({ data: user });
    });

    // Clearing a cookie
    server.post("/logout", async (request, reply) => {
      reply.clearCookie("sessionId", { path: "/" });
      return reply.ok({ message: "Logged out" });
    });
  },
});
```

---

## Common Use Cases & Best Practices

1. **Always Use `httpOnly: true`**: Prevents client-side JavaScript (`document.cookie`) from reading authentication tokens, neutralizing XSS credential theft.
2. **Key Rotation with Array Secrets**: Set `secret: [newKey, oldKey]`. `@fastify/cookie` signs new cookies with `newKey` while still verifying existing cookies signed with `oldKey`.
3. **Set `SameSite: "lax"` or `"strict"`**: Mitigates Cross-Site Request Forgery (CSRF) attacks by restricting cookie transmission across cross-site navigations.

---

## Edge Cases & Limitations

- **Peer Dependency Fallback**: If `@fastify/cookie` is not installed, the plugin skips registration; `request.cookies` will be undefined.
- **Cookie Size Limits**: Web browsers limit individual cookies to 4KB (4096 bytes). Do not store large session objects directly in cookies; store an opaque session token and keep the session state in Redis or a database.

---

## Related Features

- [CSRF Protection](csrf-protection.md)
- [Helmet](helmet.md)
- [Shared Utilities](utilities.md)
