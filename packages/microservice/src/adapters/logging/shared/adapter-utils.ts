import { LoggerContext, LogLevel } from '@/observability/logger.js';

export function normalizeArgs(message: unknown, context?: unknown): { message: string; context: LoggerContext } {
  if (typeof message === 'string') {
    return { message, context: (context as LoggerContext) ?? {} };
  }
  return {
    message: typeof context === 'string' ? context : '',
    context: (message as LoggerContext) ?? {},
  };
}

export function createLogFn<AdapterLogger extends { [key: string]: any }>(
  adapterLogger: AdapterLogger
): (level: LogLevel, messageOrContext: unknown, contextOrMessage?: unknown) => void {
  return (level: LogLevel, messageOrContext: unknown, contextOrMessage?: unknown): void => {
    const { message, context } = normalizeArgs(messageOrContext, contextOrMessage);
    (adapterLogger as any)[level](context, message);
  };
}

export function createErrorFn<AdapterLogger extends { error: any; fatal: any }>(
  adapterLogger: AdapterLogger
): (messageOrContext: unknown, contextOrMessage?: unknown) => void {
  return (messageOrContext: unknown, contextOrMessage?: unknown): void => {
    if (messageOrContext instanceof Error) {
      adapterLogger.error(messageOrContext, contextOrMessage as string);
    } else {
      const { message, context } = normalizeArgs(messageOrContext, contextOrMessage);
      adapterLogger.error(context, message);
    }
  };
}

export function createFatalFn<AdapterLogger extends { fatal: any }>(
  adapterLogger: AdapterLogger
): (messageOrContext: unknown, contextOrMessage?: unknown) => void {
  return (messageOrContext: unknown, contextOrMessage?: unknown): void => {
    if (messageOrContext instanceof Error) {
      adapterLogger.fatal(messageOrContext, contextOrMessage as string);
    } else {
      const { message, context } = normalizeArgs(messageOrContext, contextOrMessage);
      adapterLogger.fatal(context, message);
    }
  };
}

export function createChildFn<AdapterLogger extends { child: any }>(
  adapterLogger: AdapterLogger,
  adaptFn: (childLogger: AdapterLogger) => Logger
): (bindings: LoggerContext) => Logger {
  return (bindings: LoggerContext): Logger => {
    const childLogger = adapterLogger.child(bindings as Record<string, unknown>);
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