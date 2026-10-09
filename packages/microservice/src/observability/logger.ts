import pino, { Logger, LoggerOptions } from 'pino';

export interface LoggerConfig {
  level?: string;
  pretty?: boolean;
  serviceId?: string;
  instanceId?: string;
}

export function createLogger(config: LoggerConfig = {}): Logger {
  const options: LoggerOptions = {
    level: config.level ?? 'info',
    base: {
      serviceId: config.serviceId,
      instanceId: config.instanceId,
    },
  };

  if (config.pretty) {
    options.transport = {
      target: 'pino-pretty',
      options: { colorize: true },
    };
  }

  return pino(options);
}

export function createChildLogger(logger: Logger, bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

export const loggerLevels = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const;