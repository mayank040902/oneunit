import { createAuth, fastifyAdapter } from "@oneunit/auth";
import fp from "fastify-plugin";
import { startServer } from "@bootstrap-framework/server";
import type { BroadcastTarget } from "@oneunit/realtime";
import {
  createDatabaseUserStore,
  createMemoryUserStore,
  ensureUsersTable,
} from "./store.js";
import { registerCombinedRoutes } from "./routes.js";

const authSecret = process.env.AUTH_SECRET ?? "change-me-in-production-use-a-long-random-string";
const databaseEnabled = Boolean(process.env.DATABASE_URL || process.env.DATABASE_HOST);
const redisEnabled = Boolean(process.env.REDIS_URL);
const memoryStore = createMemoryUserStore();

// Read the env value once and gate on the value itself. Assigning
// `process.env.KAFKA_BROKERS` while gating on a separate `kafkaEnabled` boolean
// does not narrow the type, so `brokers` stayed `string | undefined` even
// though at runtime it is always a string inside the enabled branch.
const kafkaBrokers = process.env.KAFKA_BROKERS;

const auth = createAuth({
  secret: authSecret,
  issuer: process.env.SERVICE_NAME ?? "combined-api",
  accessTokenTtl: "15m",
  refreshTokenTtl: "7d",
  userStore: memoryStore,
  rbac: {
    defaultRole: "member",
    roles: {
      member: { permissions: ["profile.read", "events.write"] },
      admin: { inherits: "member", permissions: ["user.manage"] },
    },
  },
});

const { app, address } = await startServer({
  serviceName: process.env.SERVICE_NAME ?? "combined-api",
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8080),
  logger: {
    useHttpLogger: true,
    mode: process.env.NODE_ENV === "production" ? "production" : "development",
    serviceName: process.env.SERVICE_NAME ?? "combined-api",
  },
  cors: {
    origin: process.env.CORS_ORIGIN?.split(",") ?? true,
    credentials: true,
  },
  helmet: true,
  cookie: { secret: process.env.COOKIE_SECRET ?? authSecret },
  compress: true,
  rateLimit: { max: 200, timeWindow: "1 minute" },
  database: databaseEnabled ? { application_name: "combined-api" } : false,
  // Redis is configured through `plugins`, not as a top-level key. Passing
  // `redis` at the top level was silently ignored: the server only ever reads
  // the built-in plugin list from `plugins`, so this example compiled against
  // untyped `any` and the queue routes quietly fell back to the in-memory path.
  plugins: {
    redis: redisEnabled
      ? {
          // Omitted rather than passed as undefined: `url?: string` under
          // exactOptionalPropertyTypes rejects an explicit undefined, and the
          // plugin falls back to its own default when the key is absent.
          ...(process.env.REDIS_URL && { url: process.env.REDIS_URL }),
          maxRetriesPerRequest: null,
          healthCheck: true,
          healthCheckPath: "/health/redis",
        }
      : false,
  },
  kafka: kafkaBrokers
    ? {
        brokers: kafkaBrokers,
        clientId: process.env.KAFKA_CLIENT_ID ?? "combined-api",
        groupId: process.env.KAFKA_GROUP_ID ?? "combined-workers",
        autoConnectProducer: true,
      }
    : false,
  realtime: {
    websocketLibrary: "fastify",
  },
  // fp() is required, not cosmetic. A plugin passed to server.register is
  // encapsulated by default, so decorate("authenticate") inside it stays
  // invisible to routes declared at the root, and every authenticate()
  // preHandler throws "server.authenticate is not a function" at startup.
  // fastify-plugin opts out of that encapsulation. @oneunit/auth cannot do this
  // itself; it deliberately has no framework dependencies.
  //
  // The cast is on the adapter argument rather than the result: fastify-plugin
  // types its input as a real Fastify plugin callback, while the adapter takes
  // the minimal FastifyLike shape it actually uses (decorate, decorateRequest,
  // addHook). They are compatible at runtime, so the cast describes reality
  // rather than hiding a bug.
  extraPlugins: [fp(fastifyAdapter(auth) as never)],
  gracefulShutdown: true,
  configure: async (server) => {
    const appServer = server as typeof server & {
      db?: {
        query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
        queryOne: (sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>;
      };
      kafka?: {
        getConsumer: (
          groupId: string,
        ) => Promise<{
          subscribe: (options: { topic: string; fromBeginning?: boolean }) => Promise<void>;
          run: (options: { eachMessage: (payload: unknown) => Promise<void> }) => Promise<void>;
          disconnect: () => Promise<void>;
        }>;
      };
      realtime?: BroadcastTarget;
      log: { info: (obj: unknown, msg?: string) => void };
    };

    if (appServer.db) {
      await ensureUsersTable(appServer.db);
      auth.userStore = createDatabaseUserStore(appServer.db);
    }

    await registerCombinedRoutes(appServer as never, auth);

    // The realtime package holds no broker client, so the adapter lives here in
    // the application: consume from the broker, then call `broadcast` on the
    // hub. Swapping Kafka for Redis or NATS changes this block and nothing in
    // the realtime package.
    if (appServer.kafka && appServer.realtime) {
      const hub = appServer.realtime;
      const consumer = await appServer.kafka.getConsumer(
        `${process.env.KAFKA_GROUP_ID ?? "combined-workers"}-realtime`,
      );

      await consumer.subscribe({ topic: "user-events", fromBeginning: false });
      await consumer.run({
        eachMessage: async (payload) => {
          const record = payload as { message?: { value?: unknown } };
          await hub.broadcast("events", decodeKafkaValue(record.message?.value) ?? record);
        },
      });

      server.addHook("onClose", async () => {
        await consumer.disconnect();
      });
    }

    appServer.log.info({
      database: Boolean(appServer.db),
      redis: redisEnabled,
      kafka: Boolean(kafkaBrokers),
      realtime: true,
      auth: true,
    }, "combined example plugins");
  },
});

app.log.info(`combined example listening at ${address}`);
app.log.info("POST /auth/register  POST /auth/login  GET /me  GET /health  WS /ws/events");

function decodeKafkaValue(value: unknown): unknown {
  if (value == null) {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    const text = value.toString("utf8");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}
