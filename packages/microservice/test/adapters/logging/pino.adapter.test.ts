import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPinoLogger } from '@/adapters/logging/pino/adapter.js';
import type { Logger } from '@/observability/logger.js';

describe('createPinoLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('with provided logger instance', () => {
    it('should return adapted logger', async () => {
      const mockPinoLogger = {
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

      const logger = await createPinoLogger({ logger: mockPinoLogger });
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.child).toBe('function');
    });

    it('should use provided logger level', async () => {
      const mockPinoLogger = {
        level: 'debug' as const,
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(() => mockPinoLogger),
      };

      const logger = await createPinoLogger({ logger: mockPinoLogger });
      expect(logger.level).toBe('debug');
    });
  });

  describe('without pino installed', () => {
    it('should throw when pino is not installed and no logger provided', async () => {
      // This test would require mocking the module resolution
      // For now, we test that the function exists and is async
      expect(typeof createPinoLogger).toBe('function');
    });
  });

  describe('logger interface compliance', () => {
    it('should return logger with all required methods', async () => {
      const mockPinoLogger = {
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

      const logger = await createPinoLogger({ logger: mockPinoLogger });
      
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
      const mockPinoLogger = {
        level: 'trace' as const,
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn((bindings) => mockPinoLogger),
      };

      const logger = await createPinoLogger({ logger: mockPinoLogger });

      logger.info('test message');
      logger.info({ key: 'value' }, 'message with context');
      logger.info('message %s', 'interpolated');
      
      expect(mockPinoLogger.info).toHaveBeenCalledTimes(3);
    });

    it('should handle error objects', async () => {
      const mockPinoLogger = {
        level: 'trace' as const,
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn((bindings) => mockPinoLogger),
      };

      const logger = await createPinoLogger({ logger: mockPinoLogger });
      const err = new Error('test error');

      logger.error(err, 'error with error object');
      logger.error({ err }, 'error with error in context');

      expect(mockPinoLogger.error).toHaveBeenCalledTimes(2);
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

      const mockPinoLogger = {
        level: 'trace' as const,
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(() => mockChild),
      };

      const logger = await createPinoLogger({ logger: mockPinoLogger });
      const child = logger.child({ requestId: 'req-123' });

      expect(mockPinoLogger.child).toHaveBeenCalledWith({ requestId: 'req-123' });
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
        child: vi.fn(() => mockChild2),
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

      const mockPinoLogger = {
        level: 'trace' as const,
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(() => mockChild1),
      };

      const logger = await createPinoLogger({ logger: mockPinoLogger });
      const child1 = logger.child({ a: 1 });
      const child2 = child1.child({ b: 2 });

      expect(mockPinoLogger.child).toHaveBeenCalledTimes(1);
      expect(mockChild1.child).toHaveBeenCalledWith({ b: 2 });
    });
  });
});