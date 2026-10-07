# @oneunit/logger

Structured logging built on Pino. Fastify-friendly HTTP logging, serializers, and optional pretty transport.

Package README: `packages/logger/README.md`

## Install

```bash
npm install @oneunit/logger
```

`pino-pretty` is an optional peer for development pretty-print.

## API

| Export | Description |
| :--- | :--- |
| `createLogger(options?)` | Pino logger with env-aware defaults |
| `createChildLogger(logger, bindings)` | Child logger |
| `createHttpLogger(options?)` | `pino-http` middleware |
| `defineConfig(options?)` | Pino options for development, production, and test |
| `createSerializers(options?)` | Request, response, and error serializers |
| `createTransport(options?)` | Pretty, file, or stream transport |

## Modes

| Mode | Level | Notes |
| :--- | :--- | :--- |
| `development` | `trace` | Verbose local logging |
| `production` | `info` | Redacts tokens, passwords, and secrets |
| `test` | `silent` | Quiet unit tests |

Production redaction paths include `authorization`, `cookie`, `password`, `token`, `accessToken`, `refreshToken`, and `secret`.
