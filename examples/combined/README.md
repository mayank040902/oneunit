# Combined example

One Fastify service that wires every `@bootstrap-framework/*` package:

| Package | What it does here |
| :--- | :--- |
| `server` | Bootstrap, Helmet, CORS, cookies, compression, rate limit, health |
| `logger` | Structured Pino logs (redaction in production) |
| `errors` | Typed HTTP errors (`BadRequestError`, `NotFoundError`, `ConflictError`) |
| `auth` | Register, login, refresh, logout, JWT, RBAC |
| `database` | `users` table and auth `userStore` when `DATABASE_URL` is set |
| `redis` | Session cache, BullMQ email queue, `/health/redis` |
| `kafka` | Produce `user-events`; realtime bridge consumes them |
| `realtime` | WebSocket channel `events` at `/ws/events` |

Without Postgres, Redis, or Kafka the HTTP + JWT API still runs on an in-memory user store.

## Run

From the workspace root:

```bash
pnpm install
pnpm build
cp examples/combined/.env.example examples/combined/.env
pnpm --filter @oneunit/combined-example start
```

Listen address defaults to `http://127.0.0.1:8080`.

## HTTP API

| Method | Path | Auth |
| :--- | :--- | :--- |
| `GET` | `/health` | public |
| `GET` | `/health/redis` | public (if Redis on) |
| `POST` | `/auth/register` | public — `{ "email", "password" }` |
| `POST` | `/auth/login` | public — `{ "email", "password" }` |
| `POST` | `/auth/refresh` | public — `{ "refreshToken" }` |
| `POST` | `/auth/logout` | bearer |
| `GET` | `/me` | bearer |
| `GET` | `/admin/users` | bearer + `user.manage` |
| `POST` | `/jobs/email` | bearer — `{ "to", "template?" }` |
| `POST` | `/events` | bearer — `{ "type", "payload?" }` |
| `WS` | `/ws/events` | public demo channel |

```bash
curl -s http://127.0.0.1:8080/health

curl -s -X POST http://127.0.0.1:8080/auth/register \
  -H "content-type: application/json" \
  -d '{"email":"ada@example.com","password":"correct horse battery staple"}'

curl -s -X POST http://127.0.0.1:8080/auth/login \
  -H "content-type: application/json" \
  -d '{"email":"ada@example.com","password":"correct horse battery staple"}'
```

Registration takes only `email` and `password`. The `member` role is assigned
server-side through `auth.register(input, { roles })`, so the request body
cannot choose a role. Refresh tokens rotate on every use, so a
`POST /auth/refresh` with an already-redeemed token returns 401.

Use `accessToken` as `Authorization: Bearer <token>` on `/me`.

## Optional backends

| Variable | Effect when unset |
| :--- | :--- |
| `AUTH_SECRET` | Falls back to a development placeholder (do not use in production) |
| `DATABASE_URL` | In-memory users; `/me` returns JWT claims |
| `REDIS_URL` | No session cache, no email queue |
| `KAFKA_BROKERS` | Events only broadcast on the local WebSocket hub |

See `docs/environment.md` and `docs/combining-packages.md`.
