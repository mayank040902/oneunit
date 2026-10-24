import { AuthError, UnauthorizedError } from "../../errors/index.js";
import type { Auth } from "../../core/auth.js";
import type { ExtractTokenOptions, KoaContextLike } from "../../types/index.js";

export function koaAdapter(auth: Auth) {
  return {
    authenticate(options: ExtractTokenOptions = {}) {
      return async (ctx: KoaContextLike, next: () => Promise<void>) => {
        try {
          ctx.state.user = await auth.verifyRequest(ctx.request, options);
          ctx.state.token = auth.extractToken(ctx.request, options);
        } catch (error) {
          if (options.optional && error instanceof UnauthorizedError) {
            ctx.state.user = null;
            await next();
            return;
          }
          const err = error as AuthError;
          ctx.status = err.status ?? 401;
          ctx.body = { error: err.code ?? "AUTH_ERROR", message: err.message };
          return;
        }
        // `next()` stays outside the try so downstream handler errors propagate
        // to Koa's own error handling instead of being reported as auth failures.
        await next();
      };
    },

    requirePermission(...permissions: string[]) {
      return async (ctx: KoaContextLike, next: () => Promise<void>) => {
        if (!ctx.state.user) {
          ctx.status = 401;
          ctx.body = { error: "UNAUTHORIZED", message: "Authentication required" };
          return;
        }
        if (!auth.can(ctx.state.user, permissions)) {
          ctx.status = 403;
          ctx.body = { error: "FORBIDDEN", message: "Missing permission" };
          return;
        }
        await next();
      };
    },
  };
}
