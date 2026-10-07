# @bootstrap-framework/server

Fastify bootstrap with optional plugins for logging, database, Kafka, Redis, realtime, and errors.

Sibling packages are optional peers. Install only the ones you enable.

Package README: `packages/server/README.md`

## Install

```bash
npm install @bootstrap-framework/server
```

## Quick start

```javascript
import { startServer } from "@bootstrap-framework/server";

const { address, close } = await startServer(8080, {
  serviceName: "api",
  logger: true,
});
```

## Options

| Option | Description |
| :--- | :--- |
| `serviceName` | Service name used in health and logs |
| `host` / `port` | Listen address (`HOST` / `PORT` env override) |
| `logger` | Fastify logger or `@oneunit/logger` plugin |
| `database` | Optional PostgreSQL plugin |
| `kafka` | Optional Kafka plugin |
| `redis` | Optional Redis plugin |
| `realtime` | Optional WebSocket plugin |
| `cors` / `helmet` / `cookie` / `compress` / `rateLimit` | Fastify plugins |
| `hooks` | Lifecycle hooks |
| `configure` | Extra Fastify setup |
| `extraPlugins` | Additional Fastify plugins (auth adapter lives here) |
| `health` | Health routes, or `false` to disable |
| `gracefulShutdown` | Close on `SIGINT` / `SIGTERM` |
| `env` | Load dotenv, or `false` to skip |

Missing sibling packages are skipped with a warning. The server still starts.

## Exports

`createServer`, `startServer`, `createBootstrapServer`, `startBootstrapServer`, `start`, plugins, hooks, config helpers, health plugin.
