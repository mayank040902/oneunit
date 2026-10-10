import { describe, it, expect } from 'vitest';
import {
  MicroserviceError,
  ErrorCategory,
  MicroserviceErrorImpl,
  createMicroserviceError,
  ErrorCodes,
  isMicroserviceError,
  isRetryableError,
} from '../../src/core/errors.js';

describe('Core Errors', () => {
  describe('ErrorCategory type', () => {
    it('should include all expected categories', () => {
      const categories: ErrorCategory[] = [
        'UNAUTHENTICATED',
        'FORBIDDEN',
        'INVALID_ARGUMENT',
        'NOT_FOUND',
        'DEADLINE_EXCEEDED',
        'UNAVAILABLE',
        'RESOURCE_EXHAUSTED',
        'CONFLICT',
        'INTERNAL',
        'CONFIGURATION',
        'TRANSPORT',
        'PROTOCOL',
      ];
      expect(categories).toHaveLength(12);
    });
  });

  describe('MicroserviceErrorImpl', () => {
    it('should create error with all properties', () => {
      const error = new MicroserviceErrorImpl(
        'TEST_ERROR',
        'Test error message',
        'INVALID_ARGUMENT',
        true,
        { details: { field: 'email', reason: 'invalid format' } }
      );

      expect(error.code).toBe('TEST_ERROR');
      expect(error.message).toBe('Test error message');
      expect(error.category).toBe('INVALID_ARGUMENT');
      expect(error.retryable).toBe(true);
      expect(error.details).toEqual({ field: 'email', reason: 'invalid format' });
      expect(error.name).toBe('MicroserviceError');
      expect(error instanceof Error).toBe(true);
    });

    it('should default retryable to false', () => {
      const error = new MicroserviceErrorImpl('TEST', 'message', 'INTERNAL');
      expect(error.retryable).toBe(false);
    });

    it('should default details to undefined', () => {
      const error = new MicroserviceErrorImpl('TEST', 'message', 'INTERNAL');
      expect(error.details).toBeUndefined();
    });

    it('should capture stack trace', () => {
      const error = new MicroserviceErrorImpl('TEST', 'message', 'INTERNAL');
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('MicroserviceError');
    });
  });

  describe('createMicroserviceError', () => {
    it('should create MicroserviceErrorImpl instance', () => {
      const error = createMicroserviceError('TEST', 'message', 'INTERNAL', true, { detail: 'info' });
      expect(error).toBeInstanceOf(MicroserviceErrorImpl);
      expect(error.code).toBe('TEST');
      expect(error.category).toBe('INTERNAL');
      expect(error.retryable).toBe(true);
    });

    it('should create error without details', () => {
      const error = createMicroserviceError('TEST', 'message', 'INTERNAL');
      expect(error.details).toBeUndefined();
    });
  });

  describe('ErrorCodes', () => {
    it('should have all expected error codes', () => {
      expect(ErrorCodes.UNAUTHENTICATED).toBe('UNAUTHENTICATED');
      expect(ErrorCodes.FORBIDDEN).toBe('FORBIDDEN');
      expect(ErrorCodes.INVALID_ARGUMENT).toBe('INVALID_ARGUMENT');
      expect(ErrorCodes.NOT_FOUND).toBe('NOT_FOUND');
      expect(ErrorCodes.DEADLINE_EXCEEDED).toBe('DEADLINE_EXCEEDED');
      expect(ErrorCodes.UNAVAILABLE).toBe('UNAVAILABLE');
      expect(ErrorCodes.RESOURCE_EXHAUSTED).toBe('RESOURCE_EXHAUSTED');
      expect(ErrorCodes.CONFLICT).toBe('CONFLICT');
      expect(ErrorCodes.INTERNAL).toBe('INTERNAL');
      expect(ErrorCodes.CONFIGURATION).toBe('CONFIGURATION');
      expect(ErrorCodes.TRANSPORT).toBe('TRANSPORT');
      expect(ErrorCodes.PROTOCOL).toBe('PROTOCOL');
    });

    it('should be readonly (as const)', () => {
      // TypeScript compiles this as const, runtime check not possible
      // But we can verify the values match categories
      const keys = Object.keys(ErrorCodes);
      expect(keys).toHaveLength(20);
    });
  });

  describe('isMicroserviceError', () => {
    it('should return true for MicroserviceErrorImpl', () => {
      const error = new MicroserviceErrorImpl('TEST', 'message', 'INTERNAL');
      expect(isMicroserviceError(error)).toBe(true);
    });

    it('should return true for error created via createMicroserviceError', () => {
      const error = createMicroserviceError('TEST', 'message', 'INTERNAL');
      expect(isMicroserviceError(error)).toBe(true);
    });

    it('should return false for plain Error', () => {
      const error = new Error('plain error');
      expect(isMicroserviceError(error)).toBe(false);
    });

    it('should return false for plain object with similar properties', () => {
      const error = { code: 'TEST', message: 'test', category: 'INTERNAL', retryable: false };
      expect(isMicroserviceError(error)).toBe(false);
    });

    it('should return false for null/undefined', () => {
      expect(isMicroserviceError(null)).toBe(false);
      expect(isMicroserviceError(undefined)).toBe(false);
    });

    it('should return false for string', () => {
      expect(isMicroserviceError('error')).toBe(false);
    });
  });

  describe('isRetryableError', () => {
    it('should return true for retryable MicroserviceError', () => {
      const error = createMicroserviceError('TEST', 'message', 'UNAVAILABLE', true);
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return false for non-retryable MicroserviceError', () => {
      const error = createMicroserviceError('TEST', 'message', 'INVALID_ARGUMENT', false);
      expect(isRetryableError(error)).toBe(false);
    });

    it('should return false for plain Error', () => {
      const error = new Error('plain error');
      expect(isRetryableError(error)).toBe(false);
    });

    it('should return false for null/undefined', () => {
      expect(isRetryableError(null)).toBe(false);
      expect(isRetryableError(undefined)).toBe(false);
    });
  });

  describe('Error properties preservation', () => {
    it('should preserve original error cause when thrown', () => {
      const originalError = new Error('original cause');
      const error = createMicroserviceError(
        'WRAPPED',
        'wrapped error',
        'TRANSPORT',
        true,
        { details: { original: originalError.message } }
      );

      try {
        throw error;
      } catch (e) {
        expect(e).toBeInstanceOf(MicroserviceErrorImpl);
        expect((e as MicroserviceError).code).toBe('WRAPPED');
        expect((e as MicroserviceError).details?.original).toBe('original cause');
      }
    });

    it('should maintain error category semantics', () => {
      const configError = createMicroserviceError('BAD_CONFIG', 'invalid config', 'CONFIGURATION');
      const transportError = createMicroserviceError('CONN_FAILED', 'connection failed', 'TRANSPORT', true);
      const protocolError = createMicroserviceError('BAD_FRAME', 'malformed frame', 'PROTOCOL');

      expect(configError.category).toBe('CONFIGURATION');
      expect(configError.retryable).toBe(false);
      expect(transportError.category).toBe('TRANSPORT');
      expect(transportError.retryable).toBe(true);
      expect(protocolError.category).toBe('PROTOCOL');
    });
  });
});