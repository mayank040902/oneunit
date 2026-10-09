export interface MicroserviceError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

export type ErrorCategory =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'DEADLINE_EXCEEDED'
  | 'UNAVAILABLE'
  | 'RESOURCE_EXHAUSTED'
  | 'CONFLICT'
  | 'INTERNAL'
  | 'CONFIGURATION'
  | 'TRANSPORT'
  | 'PROTOCOL';

export class MicroserviceErrorImpl extends Error implements MicroserviceError {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    category: ErrorCategory,
    retryable = false,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'MicroserviceError';
    this.code = code;
    this.category = category;
    this.retryable = retryable;
    this.details = details;
    
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
  details?: Record<string, unknown>
): MicroserviceError {
  return new MicroserviceErrorImpl(code, message, category, retryable, details);
}

export const ErrorCodes = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  NOT_FOUND: 'NOT_FOUND',
  DEADLINE_EXCEEDED: 'DEADLINE_EXCEEDED',
  UNAVAILABLE: 'UNAVAILABLE',
  RESOURCE_EXHAUSTED: 'RESOURCE_EXHAUSTED',
  CONFLICT: 'CONFLICT',
  INTERNAL: 'INTERNAL',
  CONFIGURATION: 'CONFIGURATION',
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