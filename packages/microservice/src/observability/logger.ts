export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LoggerContext {
  [key: string]: unknown;
}

export interface Logger {
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
  child(bindings: LoggerContext): Logger;
  level: LogLevel;
}

export interface LoggerConfig {
  level?: LogLevel;
  serviceId?: string;
  instanceId?: string;
  /**
   * Application-owned concrete logger instance.
   *
   * When supplied, the framework uses it directly instead of creating its
   * own logger. The application is responsible for the logger's
   * configuration, levels, serializers, redaction, destinations, and
   * transports. The framework never creates or configures a concrete
   * logger behind the application's back.
   */
  logger?: Logger;
}

export const loggerLevels = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const;

function isLevelEnabled(current: LogLevel, target: LogLevel): boolean {
  return loggerLevels[target] >= loggerLevels[current];
}

function mergeContext(base: LoggerContext | undefined, extra: LoggerContext | undefined): LoggerContext {
  if (!base && !extra) return {};
  if (!base) return { ...extra };
  if (!extra) return { ...base };
  return { ...base, ...extra };
}

function normalizeArgs(message: unknown, context?: unknown): { message: string; context: LoggerContext } {
  if (typeof message === 'string') {
    return { message, context: (context as LoggerContext) ?? {} };
  }
  return {
    message: typeof context === 'string' ? context : '',
    context: (message as LoggerContext) ?? {},
  };
}

export class FrameworkLogger implements Logger {
  readonly level: LogLevel;
  private readonly base: LoggerContext;

  constructor(level: LogLevel = 'info', base: LoggerContext = {}) {
    this.level = level;
    this.base = { ...base };
  }

  private write(_level: LogLevel, message: string, context: LoggerContext): void {
    // Framework-owned no-op sink. Applications inject a real logger via
    // createLogger({ logger }) or by supplying their own Logger instance.
  }

  trace(message: string, context?: LoggerContext): void;
  trace(context: LoggerContext, message: string): void;
  trace(messageOrContext: unknown, contextOrMessage?: unknown): void {
    if (!isLevelEnabled(this.level, 'trace')) return;
    const { message, context } = normalizeArgs(messageOrContext, contextOrMessage);
    this.write('trace', message, mergeContext(this.base, context));
  }

  debug(message: string, context?: LoggerContext): void;
  debug(context: LoggerContext, message: string): void;
  debug(messageOrContext: unknown, contextOrMessage?: unknown): void {
    if (!isLevelEnabled(this.level, 'debug')) return;
    const { message, context } = normalizeArgs(messageOrContext, contextOrMessage);
    this.write('debug', message, mergeContext(this.base, context));
  }

  info(message: string, context?: LoggerContext): void;
  info(context: LoggerContext, message: string): void;
  info(messageOrContext: unknown, contextOrMessage?: unknown): void {
    if (!isLevelEnabled(this.level, 'info')) return;
    const { message, context } = normalizeArgs(messageOrContext, contextOrMessage);
    this.write('info', message, mergeContext(this.base, context));
  }

  warn(message: string, context?: LoggerContext): void;
  warn(context: LoggerContext, message: string): void;
  warn(messageOrContext: unknown, contextOrMessage?: unknown): void {
    if (!isLevelEnabled(this.level, 'warn')) return;
    const { message, context } = normalizeArgs(messageOrContext, contextOrMessage);
    this.write('warn', message, mergeContext(this.base, context));
  }

  error(message: string, context?: LoggerContext): void;
  error(context: LoggerContext, message: string): void;
  error(err: Error, message: string): void;
  error(messageOrContext: unknown, contextOrMessage?: unknown): void {
    if (!isLevelEnabled(this.level, 'error')) return;
    const { message, context } = normalizeArgs(messageOrContext, contextOrMessage);
    this.write('error', message, mergeContext(this.base, context));
  }

  fatal(message: string, context?: LoggerContext): void;
  fatal(context: LoggerContext, message: string): void;
  fatal(err: Error, message: string): void;
  fatal(messageOrContext: unknown, contextOrMessage?: unknown): void {
    if (!isLevelEnabled(this.level, 'fatal')) return;
    const { message, context } = normalizeArgs(messageOrContext, contextOrMessage);
    this.write('fatal', message, mergeContext(this.base, context));
  }

  child(bindings: LoggerContext): Logger {
    return new FrameworkLogger(this.level, mergeContext(this.base, bindings));
  }
}

export class NoopLogger implements Logger {
  level: LogLevel = 'info';

  trace(): void {}
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  fatal(): void {}

  child(): Logger {
    return this;
  }
}

export const noopLogger = new NoopLogger();

export function createLogger(config: LoggerConfig = {}): Logger {
  if (config.logger) {
    return config.logger;
  }

  const level = config.level && (loggerLevels as Record<string, unknown>)[config.level]
    ? config.level
    : 'info';

  return new FrameworkLogger(level, {
    ...(config.serviceId ? { serviceId: config.serviceId } : undefined),
    ...(config.instanceId ? { instanceId: config.instanceId } : undefined),
  });
}

export function createChildLogger(logger: Logger, bindings: LoggerContext): Logger {
  return logger.child(bindings);
}