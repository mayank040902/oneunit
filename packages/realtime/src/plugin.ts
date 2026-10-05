import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
  attachWebSocketAdapter,
  createConnectionAdapter,
  matchesPath,
  type AttachedWebSocketAdapter,
  type ConnectionAdapter,
  type RealtimeConnectionHandler,
  type RealtimeMessageHandler,
} from "./adapter.js";
import {
  createRealtimeHub,
  type Logger,
  type RealtimeHub,
  type RealtimeHubOptions,
} from "./hub.js";

/**
 * Fastify binding for the realtime hub.
 *
 * This module is the only place in the package that knows Fastify exists, and it
 * holds no logic of its own: it creates a hub, builds a connection adapter from
 * `src/adapter.ts`, and points Fastify's WebSocket server at it. A plain
 * `node:http` server uses the same adapter through
 * `attachWebSocketAdapter()`, so nothing Fastify-shaped reaches the core.
 */

const DEFAULT_MAX_PAYLOAD = 1024 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL = 30_000;

export type RealtimePluginLogger = Logger;

export interface RealtimePluginOptions extends Omit<RealtimeHubOptions, "heartbeat"> {
  routes?: (app: FastifyInstance) => Promise<void>;
  /** `"fastify"` registers `@fastify/websocket`; `"ws"` attaches a standalone server. */
  websocketLibrary?: "fastify" | "ws";
  path?: string;
  channel?: string;
  e2ee?: boolean;
  maxPayload?: number;
  /** `false` disables the hub heartbeat. Defaults to `true`. */
  heartbeat?: boolean;
  heartbeatInterval?: number;
  onConnection?: RealtimeConnectionHandler;
  onMessage?: RealtimeMessageHandler;
  /**
   * Join and route every accepted socket automatically. Defaults to `true`.
   *
   * Set it to `false` when the app defines its own `websocket` routes and calls
   * `hub.join()` itself.
   */
  attachConnections?: boolean;
}

/** Whether an upgrade request targets the realtime path. */
export const matchesRealtimePath = matchesPath;

/**
 * Attach the realtime hub to a Fastify instance.
 *
 * Every Fastify instance gets its own hub and its own state; nothing is shared
 * through module scope.
 *
 * @throws when called twice on the same instance.
 */
export async function registerRealtime(
  app: FastifyInstance,
  options: RealtimePluginOptions = {},
): Promise<RealtimeHub> {
  if (typeof app.hasDecorator === "function" && app.hasDecorator("realtime")) {
    throw new Error("Realtime is already registered on this Fastify instance");
  }

  const {
    routes,
    websocketLibrary = "fastify",
    path = "/ws",
    channel = "default",
    maxPayload = DEFAULT_MAX_PAYLOAD,
    heartbeat = true,
    heartbeatInterval = DEFAULT_HEARTBEAT_INTERVAL,
    onConnection,
    onMessage,
    attachConnections = true,
    limits,
    backpressure,
    authenticate,
    authorize,
    onEvent,
    e2ee,
  } = options;

  const logger = options.logger ?? resolveLogger(app);
  const hub = await createRealtimeHub({
    limits,
    backpressure,
    authenticate,
    authorize,
    onEvent,
    logger,
    e2ee,
    heartbeat:
      heartbeat === false
        ? false
        : { intervalMs: heartbeatInterval, timeoutMs: heartbeatInterval * 2 },
  });

  // Everything that can fail on a configuration mistake is checked before the
  // decorator is added. Fastify 5 has no `removeDecorator`, so a decorator applied
  // before a failed step cannot be taken back: the instance would keep a hub with
  // no server behind it and refuse every later registration with "already
  // registered". Failing first keeps a bad option a retryable mistake.
  if (websocketLibrary !== "fastify" && websocketLibrary !== "ws") {
    throw new Error(`Unknown websocketLibrary "${String(websocketLibrary)}"`);
  }

  if (
    websocketLibrary === "ws" &&
    (!app.server || typeof app.server.on !== "function")
  ) {
    throw new Error('websocketLibrary "ws" requires a real Fastify instance with app.server');
  }

  const adapter: ConnectionAdapter = createConnectionAdapter({
    hub,
    channel,
    onConnection,
    onMessage,
    logger,
  });

  const cleanups: Array<() => void | Promise<void>> = [];

  try {
    await wireTransport();
  } catch (error) {
    hub.close();
    throw error;
  }

  // The decorator is applied before `routes()` runs, because an application's
  // route callback may read `app.realtime` while it registers its routes.
  app.decorate("realtime", hub);

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) {
      return;
    }

    closed = true;
    adapter.close(1001, "Server shutting down");
    hub.close(1001, "Server shutting down");

    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
  };

  // The hooks are registered before `routes()` so that a failure in application
  // code still leaves a shutdown path: `app.close()` releases the sockets and the
  // upgrade listener.
  //
  // `preClose` runs before Fastify closes the HTTP server, which is the only
  // point at which hijacked upgrade sockets can still be released.
  try {
    app.addHook("preClose", shutdown);
  } catch {
    // Fastify older than 4.28 falls back to the onClose hook alone.
  }

  app.addHook("onClose", shutdown);

  if (typeof routes === "function") {
    await routes(app);
  }

  return hub;

  async function wireTransport(): Promise<void> {
    if (websocketLibrary === "fastify") {
      const alreadyRegistered =
        typeof app.hasDecorator === "function" && app.hasDecorator("websocketServer");

      if (alreadyRegistered) {
        logger.warn?.(
          { plugin: "@fastify/websocket" },
          "@fastify/websocket is already registered; reusing it and ignoring maxPayload",
        );
      } else {
        const websocket = await import("@fastify/websocket");
        const plugin = websocket.default ?? websocket.fastifyWebsocket;
        await app.register(plugin, { options: { maxPayload } });
      }

      const websocketServer = app.websocketServer;

      if (attachConnections && websocketServer) {
        // Reusing the existing `ws` server means the adapter listens for its
        // connections; this module never closes a server it did not create.
        const attached = await attachWebSocketAdapter(app.server, {
          adapter,
          server: websocketServer,
          attach: false,
        });

        cleanups.push(() => attached.close());
      } else if (attachConnections) {
        throw new Error(
          'websocketLibrary "fastify" requires @fastify/websocket to expose app.websocketServer',
        );
      }

      return;
    }

    const attached: AttachedWebSocketAdapter = await attachWebSocketAdapter(app.server, {
      adapter,
      path,
      maxPayload,
      attach: attachConnections,
    });

    cleanups.push(() => attached.close());
  }
}

function resolveLogger(app: FastifyInstance): Logger {
  const candidate = app.log as Logger | undefined;

  if (candidate && (typeof candidate.info === "function" || typeof candidate.warn === "function")) {
    return candidate;
  }

  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

export const realtimePlugin: FastifyPluginAsync<RealtimePluginOptions> = async (
  app,
  options,
) => {
  await registerRealtime(app, options);
};

const skipOverride = Symbol.for("skip-override");

(realtimePlugin as FastifyPluginAsync<RealtimePluginOptions> & Record<symbol, boolean>)[
  skipOverride
] = true;

export default realtimePlugin;

export { createRealtimeHub };
export {
  attachWebSocketAdapter,
  createConnectionAdapter,
  matchesPath,
  type AttachedWebSocketAdapter,
  type AttachWebSocketAdapterOptions,
  type ConnectionAdapter,
  type ConnectionAdapterOptions,
  type HttpServerLike,
  type RealtimeConnection,
  type RealtimeConnectionHandler,
  type RealtimeMessageHandler,
  type WebSocketServerLike,
} from "./adapter.js";
export type { Connection } from "./hub.js";