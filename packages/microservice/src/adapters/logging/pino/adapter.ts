import { Logger, LoggerConfig, LoggerContext, LogLevel } from '@/observability/logger.js';
import {
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

  let pinoModule: any;
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

  const options: any = {
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
        'req.headers.authorization',
        'req.headers.cookie',
      ],
      censor: '[REDACTED]',
    };
  }

  if (config.pretty) {
    let prettyModule: any;
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

  const pinoLogger = pino(options).child(baseBindings);

  return adaptPinoLogger(pinoLogger);
}

function adaptPinoLogger(pinoLogger: PinoLogger): Logger {
  const logFn = createLogFn(pinoLogger);
  const errorFn = createErrorFn(pinoLogger);
  const fatalFn = createFatalFn(pinoLogger);
  const childFn = createChildFn(pinoLogger, adaptPinoLogger);

  return adaptLogger({
    adapterLogger: pinoLogger,
    getLevel: () => pinoLogger.level,
    logFn,
    errorFn,
    fatalFn,
    childFn,
  });
}