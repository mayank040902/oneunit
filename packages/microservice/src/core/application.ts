import { LifecycleManager } from './lifecycle.js';
import { Transport, MessagePublisher, MessageSubscriber } from './capabilities.js';
import { MicroserviceConfig, ServiceConfig, KafkaAdapterConfig } from '../config/schema.js';
import { loadConfig } from '../config/loader.js';
import { ServiceRegistry, createRegistry } from '../registry/registry.js';
import { ServiceIdentity, createServiceIdentity } from '../identity/service-identity.js';
import { AuthorizationPolicy, createAuthorizationPolicy } from '../identity/authorization.js';
import { Logger, createLogger, createChildLogger } from '../observability/logger.js';
import { createKafkaTransport } from '../adapters/messaging/kafka/adapter.js';
import { createKafkaClient, type KafkaClient } from '../adapters/messaging/kafka/kafka-client.js';

export interface KafkaMessaging {
  publish(topic: string, message: unknown, options?: { key?: string; headers?: Record<string, string> }): Promise<void>;
  subscribe(topic: string, handler: (message: unknown, context: { topic: string; partition: number; offset: string; headers?: Record<string, string> }) => Promise<void>, options?: { groupId?: string }): Promise<void>;
  unsubscribe(topic: string): Promise<void>;
  disconnect(): Promise<void>;
}

export interface MicroserviceApp {
  readonly service: ServiceConfig;
  readonly config: MicroserviceConfig;
  readonly registry: ServiceRegistry;
  readonly identity: ServiceIdentity;
  readonly authorization: AuthorizationPolicy;
  readonly lifecycle: LifecycleManager;
  readonly logger: Logger;
  readonly kafka?: KafkaMessaging;

  start(): Promise<void>;
  stop(): Promise<void>;
  getTransport(name: string): Transport | undefined;
  registerTransport(transport: Transport): void;
  unregisterTransport(name: string): boolean;
}

export interface CreateAppOptions {
  configPath?: string;
  config?: Partial<MicroserviceConfig>;
  logger?: Logger;
}

async function createAppLogger(options: CreateAppOptions, config: MicroserviceConfig): Promise<Logger> {
  if (options.logger) {
    return options.logger;
  }

  const observabilityConfig = config.observability;
  if (!observabilityConfig?.logging) {
    return createLogger({ level: 'info' });
  }

  try {
    const { createOneUnitLogger } = await import('../adapters/logging/oneunit/adapter.js');
    return await createOneUnitLogger({
      mode: observabilityConfig.logLevel === 'trace' || observabilityConfig.logLevel === 'debug' ? 'development' : 'production',
      level: observabilityConfig.logLevel ?? 'info',
    });
  } catch {
    return createLogger({ 
      level: observabilityConfig.logLevel ?? 'info',
      serviceId: config.service.id,
      instanceId: config.service.instanceId,
    });
  }
}

async function createKafkaMessaging(logger: Logger, kafkaConfig: KafkaAdapterConfig): Promise<KafkaMessaging> {
  const kafkaClient = await createKafkaClient({ config: kafkaConfig, logger });
  
  return {
    async publish(topic: string, message: unknown, options?: { key?: string; headers?: Record<string, string> }) {
      await kafkaClient.publish(topic, message, options);
    },
    
    async subscribe(topic: string, handler: (message: unknown, context: { topic: string; partition: number; offset: string; headers?: Record<string, string> }) => Promise<void>, options?: { groupId?: string }) {
      await kafkaClient.subscribe(topic, handler, options);
    },
    
    async unsubscribe(topic: string) {
      await kafkaClient.unsubscribe(topic);
    },

    async disconnect() {
      await kafkaClient.disconnect();
    },
  };
}

export async function createMicroservice(options: CreateAppOptions = {}): Promise<MicroserviceApp> {
  const config = options.configPath 
    ? loadConfig(options.configPath)
    : loadConfig();

  if (options.config) {
    Object.assign(config, options.config);
  }

  const identity = createServiceIdentity(config.service);
  const registry = createRegistry(config.registry);
const authorization = createAuthorizationPolicy(config.auth.type, {
    entries: config.auth.entries,
    defaultPolicy: config.auth.defaultPolicy,
    roles: config.auth.roles,
    serviceRoles: config.auth.serviceRoles,
  });
  const lifecycle = new LifecycleManager(config.registry.healthCheckIntervalMs || 30000);
  
  const logger = await createAppLogger(options, config);

  // Auto-initialize Kafka if enabled in config
  let kafkaMessaging: KafkaMessaging | undefined;
  const kafkaConfig = config.adapters?.kafka;
  if (kafkaConfig?.enabled) {
    try {
      kafkaMessaging = await createKafkaMessaging(logger, kafkaConfig);
      logger.info('Kafka messaging initialized', { clientId: kafkaConfig.clientId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to initialize Kafka messaging', { error: msg });
      throw err;
    }
  }

  const app: MicroserviceApp = {
    service: config.service,
    config,
    registry,
    identity,
    authorization,
    lifecycle,
    logger,
    kafka: kafkaMessaging,

    start: async () => {
      await registry.register(identity.getRegistration());
      lifecycle.setHooks({
        onStop: async () => {
          await registry.deregister(identity.serviceId);
          if (kafkaMessaging) {
            await kafkaMessaging.disconnect();
          }
        },
      });
      await lifecycle.start();
    },

    stop: async () => {
      if (kafkaMessaging) {
        await kafkaMessaging.disconnect();
      }
      await lifecycle.stop();
    },

    getTransport: (name: string) => {
      return lifecycle.getTransport(name);
    },

    registerTransport: (transport: Transport) => {
      lifecycle.registerTransport(transport);
    },

    unregisterTransport: (name: string) => {
      return lifecycle.unregisterTransport(name);
    },
  };

  return app;
}

export type { MicroserviceConfig, ServiceConfig } from '../config/schema.js';
export { loadConfig } from '../config/loader.js';