import type { AuthErrorOptions } from "../types/index.js";

export class AuthError extends Error {
  override readonly name: string;
  readonly code: string;
  readonly status: number;
  override readonly cause?: unknown;

  constructor(message: string, { code = "AUTH_ERROR", status = 401, cause }: AuthErrorOptions = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    if (cause !== undefined) {
      this.cause = cause;
    }
    Error.captureStackTrace?.(this, this.constructor);
  }

  toJSON(): { name: string; message: string; code: string; status: number } {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      status: this.status,
    };
  }
}

export class InvalidTokenError extends AuthError {
  constructor(message = "Invalid or expired token", options: AuthErrorOptions = {}) {
    super(message, { code: "INVALID_TOKEN", status: 401, ...options });
  }
}

export class TokenExpiredError extends AuthError {
  constructor(message = "Token has expired", options: AuthErrorOptions = {}) {
    super(message, { code: "TOKEN_EXPIRED", status: 401, ...options });
  }
}

export class UnauthorizedError extends AuthError {
  constructor(message = "Unauthorized", options: AuthErrorOptions = {}) {
    super(message, { code: "UNAUTHORIZED", status: 401, ...options });
  }
}

export class ForbiddenError extends AuthError {
  constructor(message = "Forbidden", options: AuthErrorOptions = {}) {
    super(message, { code: "FORBIDDEN", status: 403, ...options });
  }
}

export class ConfigurationError extends AuthError {
  constructor(message = "Invalid authentication configuration", options: AuthErrorOptions = {}) {
    super(message, { code: "CONFIGURATION_ERROR", status: 500, ...options });
  }
}

export class OAuthError extends AuthError {
  constructor(message = "OAuth authentication failed", options: AuthErrorOptions = {}) {
    super(message, { code: "OAUTH_ERROR", status: 401, ...options });
  }
}

export class ProviderError extends AuthError {
  constructor(message = "Identity provider error", options: AuthErrorOptions = {}) {
    super(message, { code: "PROVIDER_ERROR", status: 502, ...options });
  }
}

export class ValidationError extends AuthError {
  constructor(message = "Validation failed", options: AuthErrorOptions = {}) {
    super(message, { code: "VALIDATION_ERROR", status: 400, ...options });
  }
}
