import pino, { Logger, LoggerOptions } from 'pino';

export interface LoggerConfig {
  level?: string;
  pretty?: boolean;
  serviceId?: string;
  instanceId?: string;
  redactSecrets?: boolean;
}

const VALID_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

const DEFAULT_REDACT_PATHS = [
  'password', 'token', 'apiKey', 'secret', 'key', 'authorization',
  'email', 'phone', 'creditCard', 'ssn',
  '*.password', '*.token', '*.apiKey', '*.secret', '*.key',
  '*.authorization', '*.password.*',
];

export function createLogger(config: LoggerConfig = {}): Logger {
  const level = VALID_LEVELS.has(config.level ?? 'info') ? (config.level ?? 'info') : 'info';

  const options: LoggerOptions = {
    level,
    base: {
      serviceId: config.serviceId,
      instanceId: config.instanceId,
    },
  };

  if (config.redactSecrets !== false) {
    options.redact = DEFAULT_REDACT_PATHS;
  }

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