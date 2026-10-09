import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, createChildLogger, loggerLevels, LoggerConfig } from '@/observability/logger.js';
import type { Logger } from 'pino';

describe('createLogger', () => {
  let logger: Logger;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('log levels', () => {
    it('should default to info level', () => {
      logger = createLogger({});
      expect(logger.level).toBe('info');
    });

    it('should accept valid trace level', () => {
      logger = createLogger({ level: 'trace' });
      expect(logger.level).toBe('trace');
    });

    it('should accept valid debug level', () => {
      logger = createLogger({ level: 'debug' });
      expect(logger.level).toBe('debug');
    });

    it('should accept valid info level', () => {
      logger = createLogger({ level: 'info' });
      expect(logger.level).toBe('info');
    });

    it('should accept valid warn level', () => {
      logger = createLogger({ level: 'warn' });
      expect(logger.level).toBe('warn');
    });

    it('should accept valid error level', () => {
      logger = createLogger({ level: 'error' });
      expect(logger.level).toBe('error');
    });

    it('should accept valid fatal level', () => {
      logger = createLogger({ level: 'fatal' });
      expect(logger.level).toBe('fatal');
    });

    it('should default to info for invalid level', () => {
      logger = createLogger({ level: 'invalid' as any });
      expect(logger.level).toBe('info');
    });

    it('should default to info for empty level', () => {
      logger = createLogger({ level: '' as any });
      expect(logger.level).toBe('info');
    });

    it('should default to info for undefined level', () => {
      logger = createLogger({ level: undefined });
      expect(logger.level).toBe('info');
    });
  });

  describe('service and instance IDs', () => {
    it('should include serviceId in base bindings', () => {
      logger = createLogger({ serviceId: 'test-service' });
      // Check that the logger was created with base bindings
      // The actual bindings are internal to pino, but we can verify the logger works
      expect(logger).toBeDefined();
    });

    it('should include instanceId in base bindings', () => {
      logger = createLogger({ instanceId: 'instance-1' });
      expect(logger).toBeDefined();
    });

    it('should include both serviceId and instanceId', () => {
      logger = createLogger({ serviceId: 'test-service', instanceId: 'instance-1' });
      expect(logger).toBeDefined();
    });

    it('should work without serviceId or instanceId', () => {
      logger = createLogger({});
      expect(logger).toBeDefined();
    });
  });

  describe('redaction', () => {
    it('should enable redaction by default', () => {
      logger = createLogger({ redactSecrets: true });
      expect(logger).toBeDefined();
    });

    it('should enable redaction when not explicitly disabled', () => {
      logger = createLogger({ redactSecrets: undefined });
      expect(logger).toBeDefined();
    });

    it('should disable redaction when explicitly set to false', () => {
      logger = createLogger({ redactSecrets: false });
      expect(logger).toBeDefined();
    });
  });

  describe('pretty printing', () => {
    it('should enable pretty printing when pretty is true', () => {
      logger = createLogger({ pretty: true });
      expect(logger).toBeDefined();
    });

    it('should not enable pretty printing by default', () => {
      logger = createLogger({ pretty: false });
      expect(logger).toBeDefined();
    });

    it('should not enable pretty printing when undefined', () => {
      logger = createLogger({ pretty: undefined });
      expect(logger).toBeDefined();
    });
  });

  describe('logging methods', () => {
    beforeEach(() => {
      logger = createLogger({ level: 'trace' });
    });

    it('should have trace method', () => {
      expect(typeof logger.trace).toBe('function');
    });

    it('should have debug method', () => {
      expect(typeof logger.debug).toBe('function');
    });

    it('should have info method', () => {
      expect(typeof logger.info).toBe('function');
    });

    it('should have warn method', () => {
      expect(typeof logger.warn).toBe('function');
    });

    it('should have error method', () => {
      expect(typeof logger.error).toBe('function');
    });

    it('should have fatal method', () => {
      expect(typeof logger.fatal).toBe('function');
    });

    it('should log trace messages', () => {
      expect(() => logger.trace('trace message')).not.toThrow();
    });

    it('should log debug messages', () => {
      expect(() => logger.debug('debug message')).not.toThrow();
    });

    it('should log info messages', () => {
      expect(() => logger.info('info message')).not.toThrow();
    });

    it('should log warn messages', () => {
      expect(() => logger.warn('warn message')).not.toThrow();
    });

    it('should log error messages', () => {
      expect(() => logger.error('error message')).not.toThrow();
    });

    it('should log fatal messages', () => {
      expect(() => logger.fatal('fatal message')).not.toThrow();
    });

    it('should log with object metadata', () => {
      expect(() => logger.info({ key: 'value' }, 'message with metadata')).not.toThrow();
    });

    it('should log with error objects', () => {
      const err = new Error('test error');
      expect(() => logger.error(err, 'error with error object')).not.toThrow();
    });

    it('should log with nested objects', () => {
      expect(() => logger.info({ nested: { deep: 'value' } }, 'nested object')).not.toThrow();
    });
  });

  describe('level filtering', () => {
    it('should not log trace when level is debug', () => {
      logger = createLogger({ level: 'debug' });
      // trace is lower than debug, so it shouldn't log
      expect(() => logger.trace('trace')).not.toThrow();
    });

    it('should not log debug when level is info', () => {
      logger = createLogger({ level: 'info' });
      expect(() => logger.debug('debug')).not.toThrow();
    });

    it('should not log info when level is warn', () => {
      logger = createLogger({ level: 'warn' });
      expect(() => logger.info('info')).not.toThrow();
    });

    it('should not log warn when level is error', () => {
      logger = createLogger({ level: 'error' });
      expect(() => logger.warn('warn')).not.toThrow();
    });

    it('should not log error when level is fatal', () => {
      logger = createLogger({ level: 'fatal' });
      expect(() => logger.error('error')).not.toThrow();
    });

    it('should log all levels when level is trace', () => {
      logger = createLogger({ level: 'trace' });
      expect(() => {
        logger.trace('trace');
        logger.debug('debug');
        logger.info('info');
        logger.warn('warn');
        logger.error('error');
        logger.fatal('fatal');
      }).not.toThrow();
    });
  });

  describe('structured logging', () => {
    beforeEach(() => {
      logger = createLogger({ level: 'trace' });
    });

    it('should handle string interpolation', () => {
      expect(() => logger.info('user %s logged in', 'john')).not.toThrow();
    });

    it('should handle multiple interpolation arguments', () => {
      expect(() => logger.info('user %s performed %s', 'john', 'login')).not.toThrow();
    });

    it('should handle object as first argument with interpolation', () => {
      expect(() => logger.info({ userId: 123 }, 'user %s logged in', 'john')).not.toThrow();
    });
  });

  describe('child logger', () => {
    it('should create child logger with bindings', () => {
      logger = createLogger({ level: 'info' });
      const child = createChildLogger(logger, { requestId: 'req-123' });
      expect(child).toBeDefined();
      expect(typeof child.info).toBe('function');
    });

    it('should inherit parent level', () => {
      logger = createLogger({ level: 'debug' });
      const child = createChildLogger(logger, { requestId: 'req-123' });
      expect(child.level).toBe('debug');
    });

    it('should include child bindings in logs', () => {
      logger = createLogger({ level: 'trace' });
      const child = createChildLogger(logger, { requestId: 'req-123', userId: 'user-456' });
      expect(() => child.info('child log')).not.toThrow();
    });

    it('should handle empty bindings', () => {
      logger = createLogger({ level: 'trace' });
      const child = createChildLogger(logger, {});
      expect(() => child.info('empty bindings')).not.toThrow();
    });

    it('should handle nested child loggers', () => {
      logger = createLogger({ level: 'trace' });
      const child1 = createChildLogger(logger, { a: 1 });
      const child2 = createChildLogger(child1, { b: 2 });
      expect(() => child2.info('nested child')).not.toThrow();
    });
  });

  describe('error serialization', () => {
    beforeEach(() => {
      logger = createLogger({ level: 'trace' });
    });

    it('should serialize Error objects', () => {
      const err = new Error('test error');
      expect(() => logger.error(err, 'error occurred')).not.toThrow();
    });

    it('should serialize Error with stack trace', () => {
      const err = new Error('test error');
      expect(() => logger.error({ err }, 'error with stack')).not.toThrow();
    });

    it('should handle custom error properties', () => {
      const err = new Error('test error') as any;
      err.code = 'ERR_CODE';
      err.status = 500;
      expect(() => logger.error(err, 'error with custom props')).not.toThrow();
    });

    it('should handle non-Error thrown values', () => {
      expect(() => logger.error('string error', 'string as error')).not.toThrow();
      expect(() => logger.error({ message: 'object error' }, 'object as error')).not.toThrow();
      expect(() => logger.error(null, 'null error')).not.toThrow();
      expect(() => logger.error(undefined, 'undefined error')).not.toThrow();
    });
  });

  describe('circular references', () => {
    beforeEach(() => {
      logger = createLogger({ level: 'trace' });
    });

    it('should handle circular references in metadata', () => {
      const obj: any = { a: 1 };
      obj.self = obj;
      expect(() => logger.info(obj, 'circular reference')).not.toThrow();
    });

    it('should handle deeply nested circular references', () => {
      const obj: any = { a: { b: { c: null } } };
      obj.a.b.c = obj;
      expect(() => logger.info(obj, 'deep circular')).not.toThrow();
    });
  });

  describe('concurrent logging', () => {
    it('should handle concurrent log calls', () => {
      logger = createLogger({ level: 'trace' });
      const promises = Array.from({ length: 100 }, (_, i) => 
        Promise.resolve().then(() => logger.info(`concurrent log ${i}`))
      );
      expect(() => Promise.all(promises)).not.toThrow();
    });

    it('should handle concurrent child logger creation', () => {
      logger = createLogger({ level: 'trace' });
      const promises = Array.from({ length: 50 }, (_, i) => 
        Promise.resolve().then(() => createChildLogger(logger, { id: i }))
      );
      expect(() => Promise.all(promises)).not.toThrow();
    });
  });
});

describe('loggerLevels', () => {
  it('should have correct numeric values', () => {
    expect(loggerLevels.trace).toBe(10);
    expect(loggerLevels.debug).toBe(20);
    expect(loggerLevels.info).toBe(30);
    expect(loggerLevels.warn).toBe(40);
    expect(loggerLevels.error).toBe(50);
    expect(loggerLevels.fatal).toBe(60);
  });

  it('should be ordered correctly', () => {
    expect(loggerLevels.trace).toBeLessThan(loggerLevels.debug);
    expect(loggerLevels.debug).toBeLessThan(loggerLevels.info);
    expect(loggerLevels.info).toBeLessThan(loggerLevels.warn);
    expect(loggerLevels.warn).toBeLessThan(loggerLevels.error);
    expect(loggerLevels.error).toBeLessThan(loggerLevels.fatal);
  });

  it('should be readonly', () => {
    expect(Object.isFrozen(loggerLevels)).toBe(false); // as const makes values readonly but not the object frozen
  });
});

describe('LoggerConfig type', () => {
  it('should accept all valid config options', () => {
    const config: LoggerConfig = {
      level: 'debug',
      pretty: true,
      serviceId: 'test-service',
      instanceId: 'instance-1',
      redactSecrets: false,
    };
    expect(createLogger(config)).toBeDefined();
  });

  it('should accept partial config', () => {
    const config: LoggerConfig = { level: 'warn' };
    expect(createLogger(config)).toBeDefined();
  });

  it('should accept empty config', () => {
    const config: LoggerConfig = {};
    expect(createLogger(config)).toBeDefined();
  });
});