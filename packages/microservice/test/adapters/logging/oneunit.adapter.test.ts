import { describe, it, expect, vi } from 'vitest';
import { createOneUnitLogger } from '@/adapters/logging/oneunit/adapter.js';
import type { Logger } from '@/observability/logger.js';

describe('createOneUnitLogger', () => {
  describe('with provided logger instance', () => {
    it('should return adapted logger', async () => {
      const mockOneUnitLogger = {
        level: 'info' as const,
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn((bindings) => ({
          level: 'info' as const,
          trace: vi.fn(),
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          fatal: vi.fn(),
          child: vi.fn(),
        })),
      };

      const logger = await createOneUnitLogger({ logger: mockOneUnitLogger });
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.child).toBe('function');
    });

    it('should use provided logger level', async () => {
      const mockOneUnitLogger = {
        level: 'debug' as const,
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(() => mockOneUnitLogger),
      };

      const logger = await createOneUnitLogger({ logger: mockOneUnitLogger });
      expect(logger.level).toBe('debug');
    });
  });

  describe('logger interface compliance', () => {
    it('should return logger with all required methods', async () => {
      const mockOneUnitLogger = {
        level: 'trace' as const,
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn((bindings) => ({
          level: 'trace' as const,
          trace: vi.fn(),
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          fatal: vi.fn(),
          child: vi.fn(),
        })),
      };

      const logger = await createOneUnitLogger({ logger: mockOneUnitLogger });

      expect(typeof logger.trace).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.fatal).toBe('function');
      expect(typeof logger.child).toBe('function');
      expect(typeof logger.level).toBe('string');
    });

    it('should handle message and context arguments', async () => {
      const mockOneUnitLogger = {
        level: 'trace' as const,
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn((bindings) => mockOneUnitLogger),
      };

      const logger = await createOneUnitLogger({ logger: mockOneUnitLogger });

      logger.info('test message');
      logger.info({ key: 'value' }, 'message with context');
      logger.info('message %s', 'interpolated');

      expect(mockOneUnitLogger.info).toHaveBeenCalledTimes(3);
    });

    it('should handle error objects', async () => {
      const mockOneUnitLogger = {
        level: 'trace' as const,
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn((bindings) => mockOneUnitLogger),
      };

      const logger = await createOneUnitLogger({ logger: mockOneUnitLogger });
      const err = new Error('test error');

      logger.error(err, 'error with error object');
      logger.error({ err }, 'error with error in context');

      expect(mockOneUnitLogger.error).toHaveBeenCalledTimes(2);
    });

    it('should create child logger with bindings', async () => {
      const mockChild = {
        level: 'trace' as const,
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(),
      };

      const mockOneUnitLogger = {
        level: 'trace' as const,
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(() => mockChild),
      };

      const logger = await createOneUnitLogger({ logger: mockOneUnitLogger });
      const child = logger.child({ requestId: 'req-123' });

      expect(mockOneUnitLogger.child).toHaveBeenCalledWith({ requestId: 'req-123' });
      expect(child).toBeDefined();
      expect(typeof child.info).toBe('function');
    });

    it('should handle nested child loggers', async () => {
      const mockChild1 = {
        level: 'trace' as const,
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn((bindings) => mockChild2),
      };

      const mockChild2 = {
        level: 'trace' as const,
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(),
      };

      const mockOneUnitLogger = {
        level: 'trace' as const,
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(() => mockChild1),
      };

      const logger = await createOneUnitLogger({ logger: mockOneUnitLogger });
      const child1 = logger.child({ a: 1 });
      const child2 = child1.child({ b: 2 });

      expect(mockOneUnitLogger.child).toHaveBeenCalledTimes(1);
      expect(mockChild1.child).toHaveBeenCalledWith({ b: 2 });
    });
  });
});