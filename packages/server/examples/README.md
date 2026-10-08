# @oneunit/server Examples

This directory contains production-quality, executable examples demonstrating how to use `@oneunit/server`.

## Prerequisites

- Node.js 20+
- Install the package in your project: `npm install @oneunit/server`

## Running TypeScript examples

TypeScript examples use top-level await and ESM. You can run them with `tsx`:

```bash
npx tsx examples/ts/basic/server.ts
npx tsx examples/ts/plugins/server.ts
npx tsx examples/ts/hooks/server.ts
npx tsx examples/ts/configure/server.ts
npx tsx examples/ts/health/server.ts
npx tsx examples/ts/infrastructure/server.ts
npx tsx examples/ts/graceful-shutdown/server.ts
```

Or with your preferred TypeScript runner (ts-node/esm, node with loaders, etc.).

## Running JavaScript examples

```bash
node examples/js/basic/server.js
```

## What each example demonstrates

| Example | Purpose |
|---|---|
| `ts/basic/server.ts` | Minimal server using `startServer` with a simple route via `configure`. |
| `ts/plugins/server.ts` | Application-level Fastify plugin registration via `plugins` option. |
| `ts/hooks/server.ts` | Registering request lifecycle hooks (`onRequest`, `preHandler`) via `hooks`. |
| `ts/configure/server.ts` | Using the `configure` extension point to add routes after framework setup. |
| `ts/health/server.ts` | Built-in `/health` endpoint (framework-owned). Uses `app.inject()` to demonstrate behavior. |
| `ts/infrastructure/server.ts` | Infrastructure plugins are optional/disabled by default. Shows safe configuration. |
| `ts/graceful-shutdown/server.ts` | Graceful shutdown is opt-in via `gracefulShutdown: true`. |
| `js/basic/server.js` | Same as basic example in plain JavaScript (ESM). |

## Notes

- Examples use `port: 0` or short-lived servers and call `close()` to exit cleanly.
- Infrastructure integrations (`database`, `redis`, `kafka`, `realtime`) are disabled in examples. If you enable them, the corresponding optional peer dependencies must be installed.
- Built-in framework plugins (logger, CORS, helmet, compression, rate limiting, Zod type provider, etc.) follow the package's documented defaults. Examples only override what's needed for clarity.
- All examples import only from the public `@oneunit/server` API and Node.js/Fastify types.
