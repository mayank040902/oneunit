import { Logger, LoggerContext, LogLevel } from '@/observability/logger.js';
import type { LoggerOptions } from '@oneunit/logger';
import {
  AdapterLoggerShape,
  createLogFn,
  createErrorFn,
  createFatalFn,
  adaptLogger,
} from '../shared/adapter-utils.js';

export interface OneUnitLoggerConfig {
  level?: LogLevel;
  serviceId?: string;
  instanceId?: string;
  logger?: AdapterLoggerShape;
  mode?: 'development' | 'production' | 'test';
  serializers?: LoggerOptions['serializers'];
  childBindings?: Record<string, unknown>;
  destination?: NodeJS.WritableStream;
  pino?: LoggerOptions['pino'];
}

export async function createOneUnitLogger(config: OneUnitLoggerConfig = {}): Promise<Logger> {
  if (config.logger) {
    return adaptOneUnitLogger(config.logger);
  }

  let oneUnitLoggerModule: typeof import('@oneunit/logger');
  try {
    oneUnitLoggerModule = await import('@oneunit/logger');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('Cannot find module') ||
      msg.includes('Failed to load url') ||
      msg.includes('Cannot find package')
    ) {
      throw new Error('@oneunit/logger is not installed. Install it or provide a logger instance.');
    }
    throw err;
  }

  const { createLogger, createChildLogger: oneUnitCreateChildLogger } = oneUnitLoggerModule;

  const oneUnitLogger = createLogger({
    mode: config.mode,
    serializers: config.serializers,
    childBindings: config.childBindings,
    destination: config.destination,
    pino: config.pino,
  });

  return adaptOneUnitLogger(
    oneUnitLogger as unknown as AdapterLoggerShape,
    oneUnitCreateChildLogger as unknown as (
      logger: AdapterLoggerShape,
      bindings: Record<string, unknown>
    ) => AdapterLoggerShape
  );
}

function adaptOneUnitLogger(
  oneUnitLogger: AdapterLoggerShape,
  oneUnitCreateChildLogger?: (logger: AdapterLoggerShape, bindings: Record<string, unknown>) => AdapterLoggerShape
): Logger {
  const logFn = createLogFn(oneUnitLogger);
  const errorFn = createErrorFn(oneUnitLogger);
  const fatalFn = createFatalFn(oneUnitLogger);

  const createChild = (bindings: LoggerContext): Logger => {
    const childBindings = bindings as Record<string, unknown>;
    const childLogger = oneUnitCreateChildLogger
      ? oneUnitCreateChildLogger(oneUnitLogger, childBindings)
      : oneUnitLogger.child(childBindings);
    return adaptOneUnitLogger(childLogger, oneUnitCreateChildLogger);
  };

  return adaptLogger({
    adapterLogger: oneUnitLogger,
    getLevel: () => oneUnitLogger.level as LogLevel,
    logFn,
    errorFn,
    fatalFn,
    childFn: createChild,
  });
}