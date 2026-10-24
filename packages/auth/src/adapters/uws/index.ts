import { AuthError, UnauthorizedError } from "../../errors/index.js";
import type { Auth } from "../../core/auth.js";
import type {
  ExtractTokenOptions,
  UwsHandler,
  UwsHttpRequest,
  UwsHttpResponse,
  UwsRequestSnapshot,
} from "../../types/index.js";

function jsonResponse(res: UwsHttpResponse, status: number, body: unknown): void {
  if (typeof res.cork === "function") {
    res.cork(() => {
      res.writeStatus?.(String(status));
      res.writeHeader?.("Content-Type", "application/json; charset=utf-8");
      res.end?.(JSON.stringify(body));
    });
    return;
  }

  if (typeof res.writeStatus === "function") {
    res.writeStatus(String(status));
    res.writeHeader?.("Content-Type", "application/json; charset=utf-8");
    res.end?.(JSON.stringify(body));
  }
}

function attachAbort(res: UwsHttpResponse): () => boolean {
  let aborted = false;
  if (typeof res.onAborted === "function") {
    res.onAborted(() => {
      aborted = true;
    });
  }
  return () => aborted;
}

export function snapshotUwsRequest(
  res: UwsHttpResponse,
  req: UwsHttpRequest,
  extra: Partial<UwsRequestSnapshot> = {},
): UwsRequestSnapshot {
  const headers: Record<string, string> = {};
  if (typeof req.forEach === "function") {
    req.forEach((key, value) => {
      headers[key] = value;
    });
  } else {
    const authorization = req.getHeader?.("authorization");
    const cookie = req.getHeader?.("cookie");
    if (authorization) headers.authorization = authorization;
    if (cookie) headers.cookie = cookie;
  }

  return {
    method: req.getMethod?.() ?? extra.method,
    url: req.getUrl?.() ?? extra.url,
    query: req.getQuery?.() ?? extra.query,
    headers,
    cookies: extra.cookies,
    res,
  };
}

export function uwsAdapter(auth: Auth) {
  return {
    snapshot: snapshotUwsRequest,

    authenticate(options: ExtractTokenOptions = {}) {
      return (handler: UwsHandler): UwsHandler => async (res, req) => {
        const aborted = attachAbort(res);
        const request = snapshotUwsRequest(res, req);

        try {
          request.user = await auth.verifyRequest(request, options);
          request.token = auth.extractToken(request, options);
          if (aborted()) {
            return;
          }
          return await handler(res, req, request);
        } catch (error) {
          if (options.optional && error instanceof UnauthorizedError) {
            request.user = null;
            if (aborted()) {
              return;
            }
            return await handler(res, req, request);
          }
          if (aborted()) {
            return;
          }
          const err = error as AuthError;
          jsonResponse(res, err.status ?? 401, {
            error: err.code ?? "AUTH_ERROR",
            message: err.message,
          });
        }
      };
    },

    requirePermission(...permissions: string[]) {
      const requested = permissions.flat();
      return (handler: UwsHandler): UwsHandler => async (res, req, request) => {
        const snapshot = request ?? snapshotUwsRequest(res, req);
        if (!snapshot.user) {
          jsonResponse(res, 401, { error: "UNAUTHORIZED", message: "Authentication required" });
          return;
        }
        if (!auth.can(snapshot.user, requested)) {
          jsonResponse(res, 403, { error: "FORBIDDEN", message: "Missing permission" });
          return;
        }
        return await handler(res, req, snapshot);
      };
    },

    requireRole(...roles: string[]) {
      const requested = roles.flat();
      return (handler: UwsHandler): UwsHandler => async (res, req, request) => {
        const snapshot = request ?? snapshotUwsRequest(res, req);
        if (!snapshot.user) {
          jsonResponse(res, 401, { error: "UNAUTHORIZED", message: "Authentication required" });
          return;
        }
        if (!auth.hasRole(snapshot.user, requested)) {
          jsonResponse(res, 403, { error: "FORBIDDEN", message: "Insufficient role" });
          return;
        }
        return await handler(res, req, snapshot);
      };
    },

    json: jsonResponse,
  };
}
