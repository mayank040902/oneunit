import { describe, it, expect } from 'vitest';
import {
  createMicroserviceError,
  MicroserviceErrorImpl,
  isMicroserviceError,
  isRetryableError,
  isRetryableRecommendation,
  ErrorCodes,
} from '../../src/core/errors.js';

describe('Errors - Adversarial Tests', () => {
  it('should create error with all fields', () => {
    const err = createMicroserviceError('TEST_CODE', 'test message', 'INTERNAL', true, {
      details: { key: 'value' },
      nativeCode: 'NATIVE',
      nativeDetails: { native: true },
      operationId: 'op-123',
      correlationId: 'corr-456',
      retryAfterMs: 5000,
      retryableRecommendation: true,
    });
    expect(err.code).toBe('TEST_CODE');
    expect(err.message).toBe('test message');
    expect(err.category).toBe('INTERNAL');
    expect(err.retryable).toBe(true);
    expect(err.details).toEqual({ key: 'value' });
    expect(err.nativeCode).toBe('NATIVE');
    expect(err.operationId).toBe('op-123');
    expect(err.correlationId).toBe('corr-456');
    expect(err.retryAfterMs).toBe(5000);
    expect(err.retryableRecommendation).toBe(true);
    expect(err).toBeInstanceOf(Error);
  });

  it('should handle undefined options', () => {
    const err = createMicroserviceError('CODE', 'msg', 'CONFIGURATION');
    expect(err.retryable).toBe(false);
    expect(err.retryableRecommendation).toBeUndefined();
  });

  it('should detect MicroserviceError correctly', () => {
    const err = createMicroserviceError('CODE', 'msg', 'INTERNAL');
    expect(isMicroserviceError(err)).toBe(true);
    expect(isRetryableError(err)).toBe(false);
    const retryable = createMicroserviceError('CODE', 'msg', 'INTERNAL', true);
    expect(isRetryableError(retryable)).toBe(true);
  });

  it('should handle non-error objects', () => {
    expect(isMicroserviceError({})).toBe(false);
    expect(isMicroserviceError(null)).toBe(false);
    expect(isRetryableError('string')).toBe(false);
    expect(isRetryableRecommendation(null)).toBe(false);
  });

  it('should preserve stack trace', () => {
    const err = new MicroserviceErrorImpl('CODE', 'msg', 'INTERNAL');
    expect(err.stack).toBeDefined();
  });
});
