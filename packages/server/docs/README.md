# @oneunit/server Documentation

This directory is the documentation home for `@oneunit/server`.

## Start here

- [`../README.md`](../README.md) — package overview, installation, quickstart
- [`architecture.md`](architecture.md) — runtime architecture, bootstrap contract, lifecycle, plugin ordering
- [`contributing.md`](contributing.md) — contribution rules, development, and quality gates
- [`changelog.md`](changelog.md) — release history
- [`agent.md`](agent.md) — production testing/review guidance

## Feature guides

- [Bootstrap](features/bootstrap.md)
- [Configuration and environment](features/configuration-and-environment.md)
- [Hooks](features/hooks.md)
- [Health checks](features/health-checks.md)
- [System health](features/system-health.md)
- [Logging](features/logging.md)
- [Error handling](features/error-handling.md)
- [Response management](features/response-management.md)
- [Data validation (Zod)](features/data-validation.md)
- [HTTP utilities](features/compression.md), [CORS](features/cors.md), [Helmet](features/helmet.md), [Cookies](features/cookies.md), [CSRF](features/csrf-protection.md), [Multipart](features/multipart-uploads.md), [Rate limiting](features/rate-limiting.md)
- [Database](features/database.md), [Redis](features/redis.md), [Kafka](features/kafka.md), [Realtime](features/realtime.md)
- [Swagger](features/swagger.md), [Swagger UI](features/swagger-ui.md)
- [MessagePack](features/msgpack.md), [Request context](features/request-context.md), [Utilities](features/utilities.md), [Graceful shutdown](features/graceful-shutdown.md)

## Examples

- [`../examples/`](../examples/) contains runnable JavaScript and TypeScript examples.
- Start with `../examples/ts/basic.ts` and `../examples/ts/plugins.ts`.

## Test plan

- [Comprehensive test plan](test-plan.md)

## Development commands

```bash
npm run typecheck
npm run build
npm test
npm run lint
npm run pack:check
```
