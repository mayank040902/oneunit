import { LoggerContext, LogLevel } from '@/observability/logger.js';

// Shared structural shape for the concrete adapter loggers
// (pino.Logger and the local PinoLogger interface). Both expose
// the same method set, so the helper functions below stay generic
// without resorting to `any`.
export type AdapterLoggerShape = {
  level: string;
  trace(context: LoggerContext, message: string): void;
  trace(message: string, context?: LoggerContext): void;
  debug(context: LoggerContext, message: string): void;
  debug(message: string, context?: LoggerContext): void;
  info(context: LoggerContext, message: string): void;
  info(message: string, context?: LoggerContext): void;
  warn(context: LoggerContext, message: string): void;
  warn(message: string, context?: LoggerContext): void;
  error(context: LoggerContext, message: string): void;
  error(message: string, context?: LoggerContext): void;
  fatal(context: LoggerContext, message: string): void;
  fatal(message: string, context?: LoggerContext): void;
  child(bindings: Record<string, unknown>): AdapterLoggerShape;
};

export function normalizeArgs(message: unknown, context?: unknown): { message: string; context: LoggerContext } {
  if (typeof message === 'string') {
    return { message, context: (context as LoggerContext) ?? {} };
  }
  return {
    message: typeof context === 'string' ? context : '',
    context: (message as LoggerContext) ?? {},
  };
}

export function createLogFn<AdapterLogger extends AdapterLoggerShape>(
  adapterLogger: AdapterLogger
): (level: LogLevel, messageOrContext: unknown, contextOrMessage?: unknown) => void {
  return (level: LogLevel, messageOrContext: unknown, contextOrMessage?: unknown): void => {
    const { message, context } = normalizeArgs(messageOrContext, contextOrMessage);
    const log = (adapterLogger as Record<LogLevel, (context: LoggerContext, message: string) => void>)[level];
    log?.(context, message);
  };
}

export function createErrorFn<AdapterLogger extends AdapterLoggerShape>(
  adapterLogger: AdapterLogger
): (messageOrContext: unknown, contextOrMessage?: unknown) => void {
  return (messageOrContext: unknown, contextOrMessage?: unknown): void => {
    if (messageOrContext instanceof Error) {
      (adapterLogger.error as unknown as (err: Error, message: string) => void)(messageOrContext, contextOrMessage as string);
    } else {
      const { message, context } = normalizeArgs(messageOrContext, contextOrMessage);
      adapterLogger.error(context, message);
    }
  };
}

export function createFatalFn<AdapterLogger extends AdapterLoggerShape>(
  adapterLogger: AdapterLogger
): (messageOrContext: unknown, contextOrMessage?: unknown) => void {
  return (messageOrContext: unknown, contextOrMessage?: unknown): void => {
    if (messageOrContext instanceof Error) {
      (adapterLogger.fatal as unknown as (err: Error, message: string) => void)(messageOrContext, contextOrMessage as string);
    } else {
      const { message, context } = normalizeArgs(messageOrContext, contextOrMessage);
      adapterLogger.fatal(context, message);
    }
  };
}

export function createChildFn<AdapterLogger extends AdapterLoggerShape>(
  adapterLogger: AdapterLogger,
  adaptFn: (childLogger: AdapterLogger) => Logger
): (bindings: LoggerContext) => Logger {
  return (bindings: LoggerContext): Logger => {
    const childLogger = adapterLogger.child(bindings as Record<string, unknown>) as AdapterLogger;
    return adaptFn(childLogger);
  };
}

export interface AdaptLoggerOptions<AdapterLogger> {
  adapterLogger: AdapterLogger;
  getLevel: () => LogLevel;
  logFn: (level: LogLevel, messageOrContext: unknown, contextOrMessage?: unknown) => void;
  errorFn: (messageOrContext: unknown, contextOrMessage?: unknown) => void;
  fatalFn: (messageOrContext: unknown, contextOrMessage?: unknown) => void;
  childFn: (bindings: LoggerContext) => Logger;
}

export function adaptLogger<AdapterLogger>(options: AdaptLoggerOptions<AdapterLogger>): Logger {
  return {
    level: options.getLevel(),
    trace: (messageOrContext: unknown, contextOrMessage?: unknown) => options.logFn('trace', messageOrContext, contextOrMessage),
    debug: (messageOrContext: unknown, contextOrMessage?: unknown) => options.logFn('debug', messageOrContext, contextOrMessage),
    info: (messageOrContext: unknown, contextOrMessage?: unknown) => options.logFn('info', messageOrContext, contextOrMessage),
    warn: (messageOrContext: unknown, contextOrMessage?: unknown) => options.logFn('warn', messageOrContext, contextOrMessage),
    error: options.errorFn,
    fatal: options.fatalFn,
    child: options.childFn,
  };
}

import { Logger } from '@/observability/logger.js';