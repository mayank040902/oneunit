# Getting started

## Install one package

Each package is published independently. Install only what you need:

```bash
npm install @bootstrap-framework/server
```

Sibling packages are optional peers. Install them when you enable the matching plugin:

```bash
npm install @oneunit/logger
npm install @bootstrap-framework/errors
npm install @oneunit/auth
npm install @oneunit/database
npm install @oneunit/redis
npm install @oneunit/kafka
npm install @bootstrap-framework/realtime
```

Requires **Node.js 20+**.

## First server

```javascript
import { startServer } from "@bootstrap-framework/server";

const { address, close } = await startServer(8080, {
  serviceName: "api",
  logger: true,
  gracefulShutdown: true,
});

console.log(`listening at ${address}`);
```

Missing sibling packages are skipped with a warning. The server still starts.

## Create without listening

Use this in tests:

```javascript
import { createServer } from "@bootstrap-framework/server";

const app = await createServer({
  serviceName: "api",
  logger: true,
  database: false,
  kafka: false,
  realtime: false,
});

await app.inject({ method: "GET", url: "/health" });
await app.close();
```

## Workspace development

Clone https://github.com/mayank040902/framework

```bash
pnpm install
pnpm build
pnpm test
```

Build or test a single package:

```bash
pnpm --filter @oneunit/kafka build
pnpm --filter @oneunit/kafka test
```

## Next

- Architecture: `docs/architecture.md`
- Combine every package: `docs/combining-packages.md`
- Security: `docs/security.md`
- Combined app: `examples/combined`
