# Configuration and Environment

## Overview & Purpose

The **Configuration and Environment** subsystem handles environment discovery, `.env` file loading, and strongly-typed environment variable parsing for `@oneunit/server`. It ensures:
- Safe, automatic loading of base `.env` files overlaid with environment-specific files (e.g., `.env.production`, `.env.test`, `.env.development`).
- Normalized service settings (`port`, `host`, `serviceName`, `nodeEnv`) with fallback defaults.
- Type-safe parsers for numbers, booleans, trimmed strings, and comma-separated lists, avoiding bugs caused by string comparisons like `process.env.FLAG === "false"`.
- Clean testing isolation by allowing environment loading to be completely skipped (`env: false`).

---

## Installation & Import Requirements

```typescript
import {
  loadEnv,
  serviceConfig,
  nodeEnv,
  resolveNodeEnv,
  isDevelopment,
  isProduction,
  isTest,
  envString,
  envNumber,
  envBool,
  envList,
  envFile,
  type LoadEnvOptions,
} from "@oneunit/server";

// Alternatively from subpath:
import {
  loadEnv,
  serviceConfig,
  nodeEnv,
  envString,
  envNumber,
  envBool,
  envList,
} from "@oneunit/server/config";
```

Optional peer: `dotenv` is dynamically imported at runtime. If `dotenv` is not installed, environment loading is skipped silently without crashing.

---

## Architecture & How It Works

### File Loading Hierarchy
When `loadEnv()` runs (automatically triggered by `createBootstrapServer` unless `env: false`):
1. If `options.path` is specified, `dotenv` loads that exact file with `override: true`.
2. Otherwise, `loadEnv` loads `<dir>/.env`.
3. Next, `loadEnv` resolves `.env.<NODE_ENV>` via `envFile(dir)` and loads it with `override: true`, allowing environment-specific values to override the base `.env`.
4. If `dotenv` is missing from `node_modules`, it catches the import error gracefully.

### Precedence Order
Runtime settings are resolved in the following priority order (highest to lowest):
1. Direct options passed to `startServer({ port, host, serviceName })`
2. Process environment variables (`PORT`, `HOST`, `SERVICE_NAME`, `NODE_ENV`)
3. Environment-specific file (`.env.<NODE_ENV>`)
4. Base file (`.env`)
5. Hardcoded server defaults (`port: 8080`, `host: "127.0.0.1"`, `serviceName: "app"`, `NODE_ENV: "development"`)

---

## Configuration & Helper Functions

### 1. `loadEnv(options?: LoadEnvOptions): Promise<void>`
Loads environment files into `process.env`.

```typescript
interface LoadEnvOptions {
  /** Base directory to search for .env files. Defaults to process.cwd() */
  dir?: string;
  /** Explicit path to a dotenv file. Bypasses automatic .env / .env.<env> lookup */
  path?: string;
}
```

### 2. `serviceConfig(port, host, serviceName, nodeEnv?)`
Calculates resolved service defaults merged with environment variables.

```typescript
const config = serviceConfig(8080, "127.0.0.1", "catalog-service");
// Returns:
// {
//   port: number,           // Reads process.env.PORT || 8080
//   host: string,           // Reads process.env.HOST || "127.0.0.1"
//   serviceName: string,    // Reads process.env.SERVICE_NAME || "catalog-service"
//   nodeEnv: string,        // Lowercased normalized NODE_ENV
//   isDevelopment: boolean, // true if NODE_ENV === "development"
//   isProduction: boolean,  // true if NODE_ENV === "production"
//   isTest: boolean         // true if NODE_ENV === "test"
// }
```

### 3. Environment Type Parsers

| Function | Signature | Description & Truthiness Rules |
| :--- | :--- | :--- |
| `envString` | `envString(name, fallback?): string \| undefined` | Trims whitespace. Whitespace-only or missing values return `fallback`. |
| `envNumber` | `envNumber(name, fallback?): number \| undefined` | Parses finite numbers via `Number(val)`. `NaN`, infinite, or empty values return `fallback`. |
| `envBool` | `envBool(name, fallback?): boolean \| undefined` | Case-insensitive boolean parsing.<br>**Truthy**: `"true"`, `"1"`, `"yes"`, `"on"`<br>**Falsy**: `"false"`, `"0"`, `"no"`, `"off"`<br>Other values return `fallback`. |
| `envList` | `envList(name, fallback?): string[] \| undefined` | Parses comma-separated values (`val1, val2`), trims items, filters out empty items. |
| `resolveNodeEnv` | `resolveNodeEnv(val?): string` | Trims, lowercases, and defaults to `"development"` if unset. |
| `isDevelopment` | `isDevelopment(val?): boolean` | Returns true if effective environment is `"development"`. |
| `isProduction` | `isProduction(val?): boolean` | Returns true if effective environment is `"production"`. |
| `isTest` | `isTest(val?): boolean` | Returns true if effective environment is `"test"`. |
| `envFile` | `envFile(baseDir, nodeEnv?): string` | Returns path to `<baseDir>/.env.<NODE_ENV>`. |

---

## Usage Examples

### 1. Typical Application Startup with Custom Environment

```typescript
import { startServer, serviceConfig } from "@oneunit/server";
import { envBool, envNumber } from "@oneunit/server/config";

// Read app-specific configuration
const enableSwagger = envBool("ENABLE_SWAGGER", false);
const maxConnections = envNumber("MAX_DB_CONNECTIONS", 20);

const { app } = await startServer({
  // Load configuration from custom directory:
  env: {
    dir: "/app/config",
  },
  swagger: enableSwagger,
  swaggerUI: enableSwagger,
});
```

### 2. Typed Parsing in Database and Security Setups

```typescript
import { envBool, envList, envNumber, envString } from "@oneunit/server/config";

export const appConfig = {
  db: {
    url: envString("DATABASE_URL", "postgresql://localhost:5432/mydb"),
    poolSize: envNumber("DB_POOL_SIZE", 10),
    ssl: envBool("DB_SSL", false),
  },
  cors: {
    allowedOrigins: envList("CORS_ALLOWED_ORIGINS", ["http://localhost:3000"]),
  },
  featureFlags: {
    enableBilling: envBool("FEATURE_BILLING", true),
  },
};
```

### 3. Isolated Testing Without `.env` Coupling

```typescript
import { createServer } from "@oneunit/server";

const testApp = await createServer({
  env: false, // Prevents loading developer's local .env during CI or test suites
  serviceName: "test-unit",
  port: 0,
});
```

---

## Common Use Cases & Best Practices

1. **Avoid `process.env` Booleans Directly**: Never write `Boolean(process.env.DEBUG)` because `"false"` evaluates to `true` in JavaScript! Always use `envBool("DEBUG", false)`.
2. **Set Sensible Fallbacks**: Always pass a fallback to parser helpers so the application can start in local development without requiring a massive list of environment variables.
3. **Use `isProduction()` for Conditional Guards**: Disable development tools (stack traces, open CORS, Swagger UI) when `isProduction()` evaluates to `true`.
4. **Use `env: false` in Automated Testing**: Keeps unit tests deterministic and independent of developer machine environments.

---

## Edge Cases & Limitations

- **Whitespace-Only Values**: An environment variable set to `"   "` (spaces) is treated as unset by `envString`, `envNumber`, and `envBool`, returning the fallback.
- **Missing `dotenv`**: If `dotenv` is omitted from `package.json`, `@oneunit/server` does not throw an error; it simply skips file loading and relies on existing `process.env`.
- **Case-Insensitive Booleans**: `envBool` handles `TRUE`, `True`, `Yes`, `ON`, `0`, etc., but unrecognized words (e.g. `"enabled"`) fall back to the default fallback parameter.

---

## Related Features

- [Bootstrap](bootstrap.md)
- [Health Checks](health-checks.md)
- [CORS](cors.md)
