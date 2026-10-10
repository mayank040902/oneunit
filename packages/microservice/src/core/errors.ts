export interface MicroserviceError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly retryableRecommendation?: boolean;
  readonly details?: Record<string, unknown>;
  readonly nativeCode?: string;
  readonly nativeDetails?: unknown;
  readonly operationId?: string;
  readonly correlationId?: string;
  readonly retryAfterMs?: number;
}

export type ErrorCategory =
  | 'UNAUTHENTICATED'
  | 'AUTHENTICATION'
  | 'FORBIDDEN'
  | 'AUTHORIZATION'
  | 'INVALID_ARGUMENT'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'DEADLINE_EXCEEDED'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  | 'RESOURCE_EXHAUSTED'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'CANCELLED'
  | 'INTERNAL'
  | 'CONFIGURATION'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'CONNECTION'
  | 'TRANSPORT'
  | 'PROTOCOL';

export class MicroserviceErrorImpl extends Error implements MicroserviceError {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly retryableRecommendation?: boolean;
  readonly details?: Record<string, unknown>;
  readonly nativeCode?: string;
  readonly nativeDetails?: unknown;
  readonly operationId?: string;
  readonly correlationId?: string;
  readonly retryAfterMs?: number;

  constructor(
    code: string,
    message: string,
    category: ErrorCategory,
    retryable = false,
    options?: {
      details?: Record<string, unknown>;
      nativeCode?: string;
      nativeDetails?: unknown;
      operationId?: string;
      correlationId?: string;
      retryAfterMs?: number;
      retryableRecommendation?: boolean;
    }
  ) {
    super(message);
    this.name = 'MicroserviceError';
    this.code = code;
    this.category = category;
    this.retryable = retryable;
    this.details = options?.details;
    this.nativeCode = options?.nativeCode;
    this.nativeDetails = options?.nativeDetails;
    this.operationId = options?.operationId;
    this.correlationId = options?.correlationId;
    this.retryAfterMs = options?.retryAfterMs;
    this.retryableRecommendation = options?.retryableRecommendation;

    // Maintains proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MicroserviceErrorImpl);
    }
  }
}

export function createMicroserviceError(
  code: string,
  message: string,
  category: ErrorCategory,
  retryable = false,
  options?: {
    details?: Record<string, unknown>;
    nativeCode?: string;
    nativeDetails?: unknown;
    operationId?: string;
    correlationId?: string;
    retryAfterMs?: number;
    retryableRecommendation?: boolean;
  }
): MicroserviceError {
  return new MicroserviceErrorImpl(code, message, category, retryable, options);
}

export const ErrorCodes = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  AUTHENTICATION: 'AUTHENTICATION',
  FORBIDDEN: 'FORBIDDEN',
  AUTHORIZATION: 'AUTHORIZATION',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  DEADLINE_EXCEEDED: 'DEADLINE_EXCEEDED',
  TIMEOUT: 'TIMEOUT',
  UNAVAILABLE: 'UNAVAILABLE',
  RESOURCE_EXHAUSTED: 'RESOURCE_EXHAUSTED',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  CANCELLED: 'CANCELLED',
  INTERNAL: 'INTERNAL',
  CONFIGURATION: 'CONFIGURATION',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  CONNECTION: 'CONNECTION',
  TRANSPORT: 'TRANSPORT',
  PROTOCOL: 'PROTOCOL',
} as const;

export function isMicroserviceError(error: unknown): error is MicroserviceError {
  return (
    error instanceof Error &&
    'code' in error &&
    'category' in error &&
    'retryable' in error
  );
}

export function isRetryableError(error: unknown): boolean {
  return isMicroserviceError(error) && error.retryable;
}

export function isRetryableRecommendation(error: unknown): boolean {
  return isMicroserviceError(error) && error.retryableRecommendation === true;
}

export function getErrorCategory(error: unknown): ErrorCategory | undefined {
  return isMicroserviceError(error) ? error.category : undefined;
}

export function mapNativeError(
  error: unknown,
  category: ErrorCategory,
  code: string,
  message: string,
  options?: {
    nativeCode?: string;
    nativeDetails?: unknown;
    operationId?: string;
    correlationId?: string;
    retryAfterMs?: number;
    retryable?: boolean;
    retryableRecommendation?: boolean;
    details?: Record<string, unknown>;
  }
): MicroserviceError {
  return createMicroserviceError(
    code,
    message,
    category,
    options?.retryable ?? false,
    {
      nativeCode: options?.nativeCode,
      nativeDetails: options?.nativeDetails ?? (error instanceof Error ? { message: error.message, name: error.name } : { error: String(error) }),
      operationId: options?.operationId,
      correlationId: options?.correlationId,
      retryAfterMs: options?.retryAfterMs,
      retryableRecommendation: options?.retryableRecommendation,
      details: options?.details,
    }
  );
}

export function sanitizeErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const { message, name } = error;
    return { message, name };
  }
  return { error: String(error) };
}