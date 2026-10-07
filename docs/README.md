# Bootstrap Framework documentation

Repository: https://github.com/mayank040902/framework

Production-ready Node.js packages for Fastify services. Each package under `packages/` is independently published as `@bootstrap-framework/*` and can be used alone or together.

## Guides

| Guide                           | Description                                              |
| :------------------------------ | :------------------------------------------------------- |
| `docs/getting-started.md`       | Install, requirements, first server                      |
| `docs/architecture.md`          | Package layout, plugin graph, request lifecycle          |
| `packages/auth/ARCHITECTURE.md` | Auth token lifecycle, refresh rotation, trust boundaries |
| `docs/security.md`              | Auth, TLS, redaction, headers, secrets                   |
| `docs/combining-packages.md`    | How all eight packages work together                     |
| `docs/environment.md`           | Environment variables for every package                  |
| `docs/examples.md`              | Package examples and the combined app                    |

## Packages

| Package                         | Guide                       | Role                                      |
| :------------------------------ | :-------------------------- | :---------------------------------------- |
| `@bootstrap-framework/server`   | `docs/packages/server.md`   | Fastify bootstrap, plugins, health, hooks |
| `@oneunit/logger`               | `docs/packages/logger.md`   | Structured Pino logging                   |
| `@bootstrap-framework/errors`   | `docs/packages/errors.md`   | Typed errors and Fastify error handling   |
| `@oneunit/auth`                 | `docs/packages/auth.md`     | JWT, RBAC, passwords, OAuth               |
| `@oneunit/database`             | `docs/packages/database.md` | PostgreSQL client, models, migrations     |
| `@oneunit/redis`                | `docs/packages/redis.md`    | ioredis client and BullMQ queues          |
| `@oneunit/kafka`                | `docs/packages/kafka.md`    | KafkaJS producer, consumer, admin         |
| `@bootstrap-framework/realtime` | `docs/packages/realtime.md` | WebSocket hub, adapter, backpressure, E2EE |

Package READMEs under `packages/*/README.md` are the source of truth for APIs.

## Combined example

`examples/combined` starts one Fastify service that enables every package:

- HTTP API with Helmet, CORS, cookies, compression, rate limits
- JWT login, refresh, RBAC-protected routes
- PostgreSQL users table via models
- Redis session cache and BullMQ email queue
- Kafka produce/consume for domain events
- WebSocket channel broadcasts, fed by an application-owned adapter
- Typed errors and structured logs

See `examples/combined/README.md`.

## Requirements

- Node.js 20+
- pnpm 11.9.0 for workspace development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

These run across every workspace project. Run `pnpm build` first on a fresh
checkout: the packages resolve each other's types through their built `dist`.

> `pnpm lint` is currently broken: root pins `typescript@^7`, which
> `typescript-eslint@8` does not support yet, so it exits before linting
> anything. It is not a required check. See
> [CONTRIBUTING.md](../CONTRIBUTING.md).
