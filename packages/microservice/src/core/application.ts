import { LifecycleManager } from './lifecycle.js';
import { Transport } from './capabilities.js';
import { MicroserviceConfig, ServiceConfig, KafkaAdapterConfig, DeepPartial } from '../config/schema.js';
import { loadConfig, mergeConfig } from '../config/loader.js';
import { ServiceRegistry, createRegistry } from '../registry/registry.js';
import { ServiceIdentity, createServiceIdentity } from '../identity/service-identity.js';
import { AuthorizationPolicy, createAuthorizationPolicy } from '../identity/authorization.js';
import { Logger, createLogger } from '../observability/logger.js';
import { AuditEventTypes, createAuditLogger, AuditLogger } from '../observability/audit.js';
import { createKafkaClient } from '../adapters/messaging/kafka/kafka-client.js';
import { MessageContext } from '../core/capabilities.js';
import { ShutdownManager } from '../internal/shutdown.js';

export interface KafkaMessaging {
  publish(topic: string, message: unknown, options?: { key?: string; headers?: Record<string, string> }): Promise<void>;
  subscribe(topic: string, handler: (message: unknown, context: MessageContext) => Promise<void>, options?: { groupId?: string }): Promise<void>;
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
  readonly audit: AuditLogger;
  readonly kafka?: KafkaMessaging;

  start(): Promise<void>;
  stop(): Promise<void>;
  isReady(): boolean;
  getTransport(name: string): Transport | undefined;
  registerTransport(transport: Transport): void;
  unregisterTransport(name: string): boolean;
}

export interface CreateAppOptions {
  configPath?: string;
  config?: DeepPartial<MicroserviceConfig>;
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
    
    async subscribe(topic: string, handler: (message: unknown, context: MessageContext) => Promise<void>, options?: { groupId?: string }) {
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
  const loaded = options.configPath
    ? loadConfig(options.configPath)
    : loadConfig();

  // Deep-merge programmatic overrides over the loaded configuration
  // and validate the final effective configuration with the full
  // schema before any runtime resource is constructed. Invalid
  // configuration fails here, before sockets or clients open.
  const config = mergeConfig(loaded, options.config ?? {});

  // Validate that a root cryptographic key is present. It must be
  // supplied explicitly via config or the CRYPTO_ROOT_KEY env var;
  // it is never generated implicitly by application construction.
  if (!config.crypto.rootKey || config.crypto.rootKey.length < 32) {
    throw new Error(
      'Missing or invalid crypto.rootKey: a root key of at least 32 characters is required. Set it in configuration or via the CRYPTO_ROOT_KEY environment variable.',
    );
  }

  const identity = createServiceIdentity(config.service);
  const registry = createRegistry(config.registry);
const authorization = createAuthorizationPolicy(config.auth.type, {
    entries: config.auth.entries,
    defaultPolicy: config.auth.defaultPolicy,
    roles: config.auth.roles,
    serviceRoles: config.auth.serviceRoles,
    authenticationEnabled: config.security?.authenticationEnabled,
  });
  const lifecycle = new LifecycleManager(config.registry.healthCheckIntervalMs || 30000);
  
  const logger = await createAppLogger(options, config);

  // Audit logger for security-sensitive lifecycle events.
  const audit = createAuditLogger('memory', { maxEvents: 10000 });

  // Shutdown manager wired to the application lifecycle. Signal handlers
  // are installed once per process by the first manager instance; subsequent
  // instances share the same process-level signal handlers.
  const shutdownManager = new ShutdownManager({
    timeoutMs: config.registry.healthCheckIntervalMs || 30000,
    signals: ['SIGTERM', 'SIGINT'],
  });

  // Register application shutdown as an ordered cleanup hook on the
  // shutdown manager so signal-triggered shutdown drains the app.
  shutdownManager.registerHook({
    name: 'microservice-app',
    priority: 100,
    handler: async () => {
      await app.stop();
    },
  });

  // Auto-initialize Kafka if enabled in config (non-blocking)
  let kafkaMessaging: KafkaMessaging | undefined;
  const kafkaConfig = config.adapters?.kafka;
  if (kafkaConfig?.enabled) {
    try {
      kafkaMessaging = await createKafkaMessaging(logger, kafkaConfig);
      logger.info('Kafka messaging initialized', { clientId: kafkaConfig.clientId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('Kafka initialization failed, continuing without Kafka', { error: msg });
      // Don't throw - allow service to start without Kafka
    }
  }

  let leaseId: string | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;

  const app: MicroserviceApp = {
    service: config.service,
    config,
    registry,
    identity,
    authorization,
    lifecycle,
    logger,
    audit,
    kafka: kafkaMessaging,

    start: async () => {
      // Register the service lease and retain the exact lease returned.
      const lease = await registry.register(identity.getRegistration());
      leaseId = lease.leaseId;

      const ttlMs = config.registry.ttlMs ?? 30000;

      // Audit the service registration.
      await audit.log({
        eventId: `reg-${Date.now()}`,
        eventType: AuditEventTypes.SERVICE_REGISTERED,
        timestamp: Date.now(),
        actor: { serviceId: identity.serviceId, instanceId: identity.instanceId },
        action: 'register',
        resource: { type: 'service', id: identity.serviceId },
        outcome: 'success',
        details: { leaseId, ttlMs },
        riskLevel: 'low',
      });

      // Start periodic heartbeat renewal before expiration.
      const heartbeatIntervalMs = config.registry.heartbeatIntervalMs ?? Math.floor(ttlMs / 2);
      heartbeatTimer = setInterval(async () => {
        try {
          await registry.renew(leaseId!);
          logger.debug('Registry lease renewed', { leaseId: leaseId!, ttlMs });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn('Registry lease renewal failed', { leaseId: leaseId!, error: msg });
        }
      }, heartbeatIntervalMs);
      heartbeatTimer.unref();

      lifecycle.setHooks({
        onStop: async () => {
          // Stop renewal before deregistering.
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
          if (leaseId) {
            try {
              await registry.deregister(leaseId);
              logger.info('Registry lease deregistered', { leaseId });

              // Audit the service deregistration.
              await audit.log({
                eventId: `dereg-${Date.now()}`,
                eventType: AuditEventTypes.SERVICE_DEREGISTERED,
                timestamp: Date.now(),
                actor: { serviceId: identity.serviceId, instanceId: identity.instanceId },
                action: 'deregister',
                resource: { type: 'service', id: identity.serviceId },
                outcome: 'success',
                details: { leaseId },
                riskLevel: 'low',
              });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ leaseId, error: msg }, 'Registry lease deregistration failed');

          // Audit the failed deregistration.
          await audit.log({
            eventId: `dereg-fail-${Date.now()}`,
            eventType: AuditEventTypes.SECURITY_ALERT,
            timestamp: Date.now(),
            actor: { serviceId: identity.serviceId, instanceId: identity.instanceId },
            action: 'deregister',
            resource: { type: 'service', id: identity.serviceId },
            outcome: 'failure',
            details: { leaseId, error: msg },
            riskLevel: 'high',
          });
        }
        leaseId = null;
          }
          if (kafkaMessaging) {
            await kafkaMessaging.disconnect();
          }
        },
      });
      await lifecycle.start();
    },

    stop: async () => {
      // Stop renewal before completing deregistration.
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (leaseId) {
        try {
          await registry.deregister(leaseId);
          logger.info('Registry lease deregistered on stop', { leaseId });

          // Audit the service deregistration.
          await audit.log({
            eventId: `dereg-stop-${Date.now()}`,
            eventType: AuditEventTypes.SERVICE_DEREGISTERED,
            timestamp: Date.now(),
            actor: { serviceId: identity.serviceId, instanceId: identity.instanceId },
            action: 'deregister',
            resource: { type: 'service', id: identity.serviceId },
            outcome: 'success',
            details: { leaseId },
            riskLevel: 'low',
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ leaseId, error: msg }, 'Registry lease deregistration failed on stop');

          // Audit the failed deregistration.
          await audit.log({
            eventId: `dereg-stop-fail-${Date.now()}`,
            eventType: AuditEventTypes.SECURITY_ALERT,
            timestamp: Date.now(),
            actor: { serviceId: identity.serviceId, instanceId: identity.instanceId },
            action: 'deregister',
            resource: { type: 'service', id: identity.serviceId },
            outcome: 'failure',
            details: { leaseId, error: msg },
            riskLevel: 'high',
          });
        }
        leaseId = null;
      }
      if (kafkaMessaging) {
        await kafkaMessaging.disconnect();
      }
      if (typeof (registry as { close?: () => Promise<void> }).close === 'function') {
        try {
          await (registry as unknown as { close: () => Promise<void> }).close();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ error: msg }, 'Registry close failed on stop');
        }
      }
      await lifecycle.stop();
    },

    isReady(): boolean {
      return lifecycle.getState() === 'running' || lifecycle.getState() === 'degraded';
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