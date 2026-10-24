import { AuthError, ForbiddenError, UnauthorizedError } from "../../errors/index.js";
import type { Auth } from "../../core/auth.js";
import type {
  ExpressNext,
  ExpressRequestLike,
  ExpressResponseLike,
  ExtractTokenOptions,
} from "../../types/index.js";

function sendError(reply: ExpressResponseLike, error: unknown): void {
  const err = error as AuthError;
  const status = err.status ?? 401;
  const body = {
    error: err.code ?? "AUTH_ERROR",
    message: err.message,
  };

  if (typeof reply.status === "function" && typeof reply.send === "function") {
    const next = reply.status(status);
    if (next && typeof next.send === "function") {
      next.send(body);
    } else {
      reply.send(body);
    }
    return;
  }
  if (typeof reply.code === "function") {
    const coded = reply.code(status);
    const send = coded.send ?? reply.send;
    if (typeof send === "function") {
      send.call(coded, body);
      return;
    }
  }
  if (typeof reply.status === "function") {
    reply.status(status);
    reply.body = body;
    return;
  }
  throw error;
}

export function expressAdapter(auth: Auth) {
  return {
    initialize() {
      return (req: ExpressRequestLike, _res: ExpressResponseLike, next?: ExpressNext) => {
        req.auth = auth;
        next?.();
      };
    },

    authenticate(options: ExtractTokenOptions = {}) {
      return async (req: ExpressRequestLike, res: ExpressResponseLike, next?: ExpressNext) => {
        try {
          req.user = await auth.verifyRequest(req, options);
          req.token = auth.extractToken(req, options);
          next?.();
        } catch (error) {
          if (options.optional && error instanceof UnauthorizedError) {
            req.user = null;
            next?.();
            return;
          }
          if (options.passthrough) {
            next?.(error);
            return;
          }
          sendError(res, error);
        }
      };
    },

    requirePermission(...permissions: string[]) {
      return (req: ExpressRequestLike, res: ExpressResponseLike, next?: ExpressNext) => {
        try {
          if (!req.user) {
            throw new UnauthorizedError("Authentication required");
          }
          auth.authorize(req.user, permissions);
          next?.();
        } catch (error) {
          sendError(res, error);
        }
      };
    },

    requireRole(...roles: string[]) {
      return (req: ExpressRequestLike, res: ExpressResponseLike, next?: ExpressNext) => {
        try {
          if (!req.user) {
            throw new UnauthorizedError("Authentication required");
          }
          if (!auth.hasRole(req.user, roles)) {
            throw new ForbiddenError("Insufficient role");
          }
          next?.();
        } catch (error) {
          sendError(res, error);
        }
      };
    },
  };
}
