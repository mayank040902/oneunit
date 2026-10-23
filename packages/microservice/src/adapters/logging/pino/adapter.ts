import { Logger, LoggerContext, LogLevel } from '@/observability/logger.js';
import type pino from 'pino';
import {
  AdapterLoggerShape,
  createLogFn,
  createErrorFn,
  createFatalFn,
  createChildFn,
  adaptLogger,
} from '../shared/adapter-utils.js';

export interface PinoLogger {
  trace(message: string, context?: LoggerContext): void;
  trace(context: LoggerContext, message: string): void;
  debug(message: string, context?: LoggerContext): void;
  debug(context: LoggerContext, message: string): void;
  info(message: string, context?: LoggerContext): void;
  info(context: LoggerContext, message: string): void;
  warn(message: string, context?: LoggerContext): void;
  warn(context: LoggerContext, message: string): void;
  error(message: string, context?: LoggerContext): void;
  error(context: LoggerContext, message: string): void;
  error(err: Error, message: string): void;
  fatal(message: string, context?: LoggerContext): void;
  fatal(context: LoggerContext, message: string): void;
  fatal(err: Error, message: string): void;
  child(bindings: LoggerContext): PinoLogger;
  level: LogLevel;
}

export interface PinoLoggerConfig {
  level?: LogLevel;
  serviceId?: string;
  instanceId?: string;
  logger?: PinoLogger;
  redactSecrets?: boolean;
  pretty?: boolean;
}

export async function createPinoLogger(config: PinoLoggerConfig = {}): Promise<Logger> {
  if (config.logger) {
    return adaptPinoLogger(config.logger);
  }

  let pinoModule: typeof import('pino');
  try {
    pinoModule = await import('pino');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('Cannot find module') ||
      msg.includes('Failed to load url') ||
      msg.includes('Cannot find package')
    ) {
      throw new Error('pino is not installed. Install it or provide a logger instance.');
    }
    throw err;
  }

  const pino = pinoModule.default || pinoModule;

  const options: pino.LoggerOptions = {
    level: config.level ?? 'info',
  };

  if (config.redactSecrets !== false) {
    options.redact = {
      paths: [
        '*.password',
        '*.secret',
        '*.token',
        '*.apiKey',
        '*.privateKey',
        '*.credentials',
        '*.authorization',
        '*.jwtSecret',
        '*.rootKey',
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers.x-api-key',
        'req.headers.x-auth-token',
      ],
      censor: '[REDACTED]',
    };
  }

  if (config.pretty) {
    let prettyModule: typeof import('pino-pretty') | undefined;
    try {
      prettyModule = await import('pino-pretty');
    } catch {
      // pino-pretty not installed, continue without it
    }
    if (prettyModule) {
      options.transport = {
        target: 'pino-pretty',
        options: { colorize: true },
      };
    }
  }

  const baseBindings: LoggerContext = {};
  if (config.serviceId) baseBindings['serviceId'] = config.serviceId;
  if (config.instanceId) baseBindings['instanceId'] = config.instanceId;

  const pinoLogger = pino(options).child(baseBindings) as unknown as PinoLogger;

  return adaptPinoLogger(pinoLogger);
}

function adaptPinoLogger(pinoLogger: PinoLogger): Logger {
  const logFn = createLogFn(pinoLogger as unknown as AdapterLoggerShape);
  const errorFn = createErrorFn(pinoLogger as unknown as AdapterLoggerShape);
  const fatalFn = createFatalFn(pinoLogger as unknown as AdapterLoggerShape);
  const childFn = createChildFn(pinoLogger as unknown as AdapterLoggerShape, (child) => adaptPinoLogger(child as unknown as PinoLogger));

  return adaptLogger({
    adapterLogger: pinoLogger as unknown as AdapterLoggerShape,
    getLevel: () => pinoLogger.level,
    logFn,
    errorFn,
    fatalFn,
    childFn,
  });
}