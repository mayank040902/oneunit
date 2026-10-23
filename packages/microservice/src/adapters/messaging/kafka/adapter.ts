import { BaseTransport } from '@/transport/transport';
import { TransportHealth, MessagePublisher, MessageSubscriber, PublishOptions, SubscribeOptions, MessageContext } from '@/core/capabilities';
import { KafkaAdapterConfig, KafkaDriver, KafkaDriverAdapter } from './types.js';
import { resolveKafkaDriver } from './driver-resolver.js';
import { Logger } from '@/observability/logger.js';
import { resolveSecurity, createSecuredDispatcher } from '@/core/secured-dispatcher.js';
import type { ResolvedSecurity } from '@/core/secured-dispatcher.js';
import type { SecuredRequestContext } from '@/core/secured-dispatcher.js';
import type { ServiceCredentials } from '@/identity/credentials.js';

export class KafkaTransport extends BaseTransport implements MessagePublisher, MessageSubscriber {
  private config: KafkaAdapterConfig;
  private logger?: Logger;
  private securityInput: unknown;
  private driverAdapter: KafkaDriverAdapter | null = null;
  private resolvedDriver: KafkaDriver = 'kafkajs';
  private securedDispatcherInstance: ReturnType<typeof createSecuredDispatcher> | null = null;

  private getSecuredDispatcher() {
    if (this.securedDispatcherInstance) return this.securedDispatcherInstance;
    const resolved = resolveSecurity(this.config, this.securityInput, this) as ResolvedSecurity;
    if (!resolved.protected) return null;
    const dispatcher = resolved.dispatcher ?? (resolved.options ? createSecuredDispatcher(resolved.options) : null);
    this.securedDispatcherInstance = dispatcher;
    return dispatcher;
  }

  private parseCredentials(value: unknown): ServiceCredentials | undefined {
    if (!value) return undefined;
    if (typeof value === 'object') return value as ServiceCredentials;
    if (typeof value === 'string') {
      try { return JSON.parse(value) as ServiceCredentials; } catch { return undefined; }
    }
    return undefined;
  }

  constructor(config: KafkaAdapterConfig, logger?: Logger | unknown, security?: unknown) {
    super({
      name: 'kafka',
      capabilities: {
        requestResponse: false,
        streaming: false,
        publishSubscribe: true,
        durableDelivery: true,
        orderedDelivery: true,
        bidirectional: false,
      },
    });
    this.config = config;
    const loggerIsLogger = !!(logger && typeof (logger as Record<string, unknown>)['info'] === 'function');
    if (loggerIsLogger) {
      this.logger = logger as Logger;
      this.securityInput = security;
    } else {
      this.securityInput = security !== undefined ? security : logger;
      if (security && typeof (security as Record<string, unknown>)['info'] === 'function') {
        this.logger = security as Logger;
      } else {
        this.logger = (config as { logger?: Logger }).logger ?? (logger && typeof (logger as Record<string, unknown>)['info'] !== 'function' ? undefined : (logger as Logger)) ?? undefined;
      }
    }
  }

  async start(): Promise<void> {
    const resolved = await resolveKafkaDriver(this.config, this.logger);
    this.resolvedDriver = resolved.driver;
    this.driverAdapter = await resolved.module.createAdapter(this.config, this.logger);
    await this.driverAdapter.start();
    this.started = true;
  }

  async close(): Promise<void> {
    if (this.driverAdapter) {
      await this.driverAdapter.close();
      this.driverAdapter = null;
    }
    this.started = false;
  }

  async healthCheck(): Promise<TransportHealth> {
    if (!this.driverAdapter) {
      return {
        status: 'unhealthy',
        checkedAt: Date.now(),
        details: { connected: false, driver: this.resolvedDriver },
      };
    }
    return this.driverAdapter.healthCheck();
  }

  async publish(topic: string, message: unknown, options: PublishOptions = {}): Promise<void> {
    if (!this.driverAdapter) {
      throw new Error('Kafka transport not started');
    }
    return this.driverAdapter.publish(topic, message, options);
  }

  async subscribe(
    topic: string, 
    handler: (message: unknown, context: MessageContext) => Promise<void>, 
    options: SubscribeOptions = {}
  ): Promise<void> {
    if (!this.driverAdapter) {
      throw new Error('Kafka transport not started');
    }
    const wrapped = async (message: unknown, context: MessageContext) => {
      const dispatcher = this.getSecuredDispatcher();
      const metadata = new Map<string, unknown>();
      if (context?.headers) {
        for (const [key, value] of Object.entries(context.headers)) {
          metadata.set(key, value);
        }
      }
      const credentials = this.parseCredentials(context?.headers?.['credentials'] ?? context?.headers?.['Credentials']);
      const request: SecuredRequestContext = {
        service: 'kafka',
        method: topic,
        transport: 'kafka',
        operation: `kafka.${topic}`,
        targetService: topic,
        credentials,
        metadata,
        attributes: { topic },
        correlationId: context?.correlationId,
      };
      const run = async () => {
        if (request.principal && metadata) {
          metadata.set('principal', request.principal);
          metadata.set('authenticatedPrincipal', request.principal);
        }
        if (request.caller && metadata) {
          metadata.set('caller', request.caller);
        }
        await handler(message, context);
      };
      if (!dispatcher) {
        return run();
      }
      await dispatcher.dispatch(request, run);
    };
    return this.driverAdapter.subscribe(topic, wrapped as unknown as (message: unknown, context: MessageContext) => Promise<void>, options);
  }

  async unsubscribe(topic: string): Promise<void> {
    if (!this.driverAdapter) {
      throw new Error('Kafka transport not started');
    }
    return this.driverAdapter.unsubscribe(topic);
  }

  getResolvedDriver(): KafkaDriver {
    return this.resolvedDriver;
  }
}

export function createKafkaTransport(config: KafkaAdapterConfig, logger?: Logger): KafkaTransport {
  return new KafkaTransport(config, logger);
}