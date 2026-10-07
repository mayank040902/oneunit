import type { FastifyInstance } from "fastify";
import { getHealthRegistry, createDatabaseHealthProvider } from "../../health/index.js";

export interface DatabasePluginOptions {
    connectionString?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
    ssl?: boolean | object;
    application_name?: string;
    logQueries?: boolean;
    logParameters?: boolean;
    slowQueryMs?: number;
    queryTimeout?: number;
    connectTimeout?: number;
    retry?: boolean | number | object;
    onQuery?: (info: { sql?: string; parameters?: unknown[]; durationMs: number; rowCount?: number; success: boolean }) => void;
    onError?: (info: { error: Error; sql?: string; durationMs: number }) => void;
    onRetry?: (info: { attempt: number; error: Error }) => void;
    healthCheckCritical?: boolean;
}

declare module "fastify" {
    interface FastifyInstance {
        db: {
            shutdown: () => Promise<void>;
            query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
            [key: string]: unknown;
        };
        database: {
            shutdown: () => Promise<void>;
            query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
            [key: string]: unknown;
        };
    }
}

async function databasePlugin(
    server: FastifyInstance,
    options: DatabasePluginOptions = {},
): Promise<void> {
    let createDatabase: (config: Record<string, unknown>) => {
        shutdown: () => Promise<void>;
        query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    };

    try {
        const dbModule = await import("@oneunit/database") as {
            createDatabase: typeof createDatabase;
        };
        createDatabase = dbModule.createDatabase;
    } catch (err) {
        server.log.warn({ err }, "database package not installed, database plugin disabled");
        return;
    }

    const {
        logQueries = false,
        logParameters = false,
        slowQueryMs = 0,
        queryTimeout = 0,
        connectTimeout = 0,
        retry,
        onQuery,
        onError,
        onRetry,
        healthCheckCritical = false,
        ...config
    } = options;

    const db = createDatabase({
        logger: server.log,
        instrumentation: {
            logQueries,
            logParameters,
            slowQueryMs,
            onQuery,
            onError,
            onRetry,
        },
        retry,
        queryTimeout,
        timeout: queryTimeout,
        connectTimeout,
        ...config,
    });

    server.decorate("db", db);
    server.decorate("database", db);

    // Register health check
    const registry = getHealthRegistry(server);
    registry.register(createDatabaseHealthProvider(
        async () => {
            await db.query("SELECT 1");
        },
        healthCheckCritical,
    ));

    server.addHook("onClose", async () => {
        await db.shutdown();
    });
}

export default databasePlugin;
export { databasePlugin };