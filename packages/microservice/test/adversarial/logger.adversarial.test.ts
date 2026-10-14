import { describe, it, expect } from 'vitest';
import { createLogger, Logger } from '../../src/observability/logger.js';

describe('Logger - Adversarial Tests', () => {
  it('should handle null/undefined context gracefully', () => {
    const logger = createLogger();
    expect(() => logger.info('msg', null as any)).not.toThrow();
    expect(() => logger.info('msg', undefined)).not.toThrow();
  });

  it('should accept both call signatures', () => {
    const logger = createLogger();
    expect(() => logger.info('msg', { key: 'v' })).not.toThrow();
    expect(() => logger.info({ key: 'v' }, 'msg')).not.toThrow();
  });

  it('should create child logger', () => {
    const logger = createLogger();
    const child = logger.child({ service: 'test' });
    expect(child).toBeDefined();
    expect(() => child.info('test')).not.toThrow();
  });

  it('should handle empty bindings', () => {
    const logger = createLogger();
    const child = logger.child({});
    expect(child).toBeDefined();
  });
});
