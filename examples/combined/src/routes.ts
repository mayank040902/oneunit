import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Auth, JwtPayload } from "@oneunit/auth";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "@oneunit/errors";
import { createQueue, createWorker } from "@oneunit/redis";

interface CombinedRequest extends FastifyRequest {
  user?: JwtPayload | null;
}

interface DatabaseLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  queryOne: (sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>;
}

interface CombinedServer extends FastifyInstance {
  auth: Auth;
  authenticate: (options?: { optional?: boolean }) => (request: FastifyRequest) => Promise<void>;
  requirePermission: (...permissions: string[]) => (request: FastifyRequest) => Promise<void>;
  requireRole: (...roles: string[]) => (request: FastifyRequest) => Promise<void>;
  db?: DatabaseLike;
  redis?: {
    set: (...args: unknown[]) => Promise<unknown>;
    get: (key: string) => Promise<string | null>;
  };
  kafka?: {
    send: (topic: string, message: unknown) => Promise<unknown>;
  };
  realtime?: {
    broadcast: (channel: string, message: unknown) => void;
    join: (channel: string, client: { id: string; socket: unknown }) => void;
    leave: (channel: string, clientId: string) => void;
  };
}

const EVENTS_TOPIC = "user-events";
const EVENTS_CHANNEL = "events";
const EMAIL_QUEUE = "email";

export async function registerCombinedRoutes(server: CombinedServer, auth: Auth): Promise<void> {
  const emailQueue = server.redis
    ? createQueue({ name: EMAIL_QUEUE, connection: server.redis as never })
    : null;

  if (server.redis) {
    createWorker({
      name: EMAIL_QUEUE,
      connection: server.redis as never,
      processor: async (job) => {
        server.log.info({ jobId: job.id, data: job.data }, "email job processed");
        return { ok: true };
      },
    });
  }

  server.post("/auth/register", async (request) => {
    const body = (request.body ?? {}) as { email?: string; password?: string };
    if (!body.email || !body.password) {
      throw new BadRequestError("email and password are required");
    }

    try {
      // Roles are server-side only. Passing them in the request body would let a
      // caller self-assign an admin role, so they go through the options argument.
      return await auth.register(
        { email: body.email, password: body.password },
        { roles: ["member"] },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "register failed";
      if (message.includes("unique") || message.includes("duplicate")) {
        throw new ConflictError("Email already exists", { field: "email" });
      }
      throw error;
    }
  });

  server.post("/auth/login", async (request) => {
    const body = (request.body ?? {}) as { email?: string; password?: string };
    if (!body.email || !body.password) {
      throw new BadRequestError("email and password are required");
    }

    const session = await auth.loginWithPassword(body.email, body.password);

    if (server.redis) {
      await server.redis.set(
        `session:${session.user.id}`,
        JSON.stringify({ userId: session.user.id, at: Date.now() }),
        "EX",
        3600,
      );
    }

    await publishEvent(server, {
      type: "user.logged_in",
      userId: session.user.id,
      at: Date.now(),
    });

    return session;
  });

  server.post("/auth/refresh", async (request) => {
    const body = (request.body ?? {}) as { refreshToken?: string };
    if (!body.refreshToken) {
      throw new BadRequestError("refreshToken is required");
    }
    return auth.refresh(body.refreshToken);
  });

  server.post("/auth/logout", { preHandler: [server.authenticate()] }, async (request: CombinedRequest) => {
    const body = (request.body ?? {}) as { refreshToken?: string };
    if (body.refreshToken) {
      await auth.logout(body.refreshToken);
    }
    return { ok: true, userId: request.user?.userId };
  });

  server.get("/me", { preHandler: [server.authenticate()] }, async (request: CombinedRequest) => {
    const userId = request.user?.userId ?? request.user?.sub;
    if (server.db) {
      const user = await server.db.queryOne(
        "SELECT id, email, roles, created_at FROM users WHERE id = $1",
        [userId],
      );
      if (!user) {
        throw new NotFoundError("User", userId);
      }
      return user;
    }
    return request.user;
  });

  server.get(
    "/admin/users",
    { preHandler: [server.authenticate(), server.requirePermission("user.manage")] },
    async () => {
      if (server.db) {
        const { rows } = await server.db.query(
          "SELECT id, email, roles, created_at FROM users ORDER BY created_at DESC LIMIT 100",
        );
        return { users: rows };
      }
      return { users: [] };
    },
  );

  server.post("/jobs/email", { preHandler: [server.authenticate()] }, async (request: CombinedRequest) => {
    const body = (request.body ?? {}) as { to?: string; template?: string };
    if (!body.to) {
      throw new BadRequestError("to is required");
    }
    if (!emailQueue) {
      throw new BadRequestError("Redis is not configured");
    }

    const job = await emailQueue.add("send", {
      to: body.to,
      template: body.template ?? "welcome",
      requestedBy: request.user?.userId,
    });

    return { queued: true, jobId: job.id };
  });

  server.post("/events", { preHandler: [server.authenticate()] }, async (request: CombinedRequest) => {
    const body = (request.body ?? {}) as { type?: string; payload?: unknown };
    if (!body.type) {
      throw new BadRequestError("type is required");
    }

    const event = {
      type: body.type,
      payload: body.payload ?? {},
      userId: request.user?.userId,
      at: Date.now(),
    };

    await publishEvent(server, event);
    return { published: true, event };
  });

  if (server.realtime) {
    // `as never` on the route options and the widened handler signature are
    // both deliberate: the realtime bridge accepts a socket-like object, while
    // Fastify types every route handler as taking a Fastify request. The
    // example narrows back to the socket shape at runtime, which is the honest
    // description of what actually arrives on a websocket route.
    server.get("/ws/events", { websocket: true } as never, ((connection: {
      socket?: { send: (data: string) => void; on: (event: string, fn: () => void) => void };
      send?: (data: string) => void;
      on?: (event: string, fn: () => void) => void;
    }) => {
      const socket = connection.socket ?? connection;
      const clientId = crypto.randomUUID();
      server.realtime?.join(EVENTS_CHANNEL, { id: clientId, socket });
      socket.send?.(JSON.stringify({ type: "connected", channel: EVENTS_CHANNEL, clientId }));
      socket.on?.("close", () => {
        server.realtime?.leave(EVENTS_CHANNEL, clientId);
      });
    }) as never);
  }
}

async function publishEvent(server: CombinedServer, event: Record<string, unknown>): Promise<void> {
  if (server.kafka) {
    await server.kafka.send(EVENTS_TOPIC, event);
  }
  server.realtime?.broadcast(EVENTS_CHANNEL, event);
}
