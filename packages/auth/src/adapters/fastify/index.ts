import { AuthError, UnauthorizedError } from "../../errors/index.js";
import type { Auth } from "../../core/auth.js";
import type {
  ExtractTokenOptions,
  FastifyLike,
  FastifyReplyLike,
  FastifyRequestLike,
} from "../../types/index.js";

export function fastifyAdapter(auth: Auth) {
  return async function plugin(fastify: FastifyLike, options: ExtractTokenOptions = {}) {
    fastify.decorate("auth", auth);
    fastify.decorateRequest("user", null);

    fastify.decorate("authenticate", (opts: ExtractTokenOptions = {}) => async (request: FastifyRequestLike, reply: FastifyReplyLike) => {
      // Merge once so the error path sees the same options as the verify path;
      // reading `opts.optional` alone ignored plugin-level configuration.
      const settings: ExtractTokenOptions = { ...options, ...opts };
      try {
        request.user = await auth.verifyRequest(request, settings);
      } catch (error) {
        if (settings.optional && error instanceof UnauthorizedError) {
          request.user = null;
          return;
        }
        const err = error as AuthError;
        return reply.code(err.status ?? 401).send({
          error: err.code ?? "AUTH_ERROR",
          message: err.message,
        });
      }
    });

    fastify.decorate("requirePermission", (...permissions: string[]) => async (request: FastifyRequestLike, reply: FastifyReplyLike) => {
      if (!request.user) {
        return reply.code(401).send({ error: "UNAUTHORIZED", message: "Authentication required" });
      }
      if (!auth.can(request.user, permissions)) {
        return reply.code(403).send({ error: "FORBIDDEN", message: "Missing permission" });
      }
    });

    fastify.decorate("requireRole", (...roles: string[]) => async (request: FastifyRequestLike, reply: FastifyReplyLike) => {
      if (!request.user) {
        return reply.code(401).send({ error: "UNAUTHORIZED", message: "Authentication required" });
      }
      if (!auth.hasRole(request.user, roles)) {
        return reply.code(403).send({ error: "FORBIDDEN", message: "Insufficient role" });
      }
    });
  };
}
