import { RpcClient, MessagePublisher, MessageSubscriber, Transport } from './capabilities.js';
import { ServiceIdentity } from '../identity/service-identity.js';
import { AuthorizationPolicy } from '../identity/authorization.js';

export interface ClientOptions {
  service: ServiceIdentity;
  authorization: AuthorizationPolicy;
  defaultTimeout?: number;
  retryPolicy?: RetryPolicy;
}

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  retryableCategories: string[];
}

export class MicroserviceClient implements RpcClient, MessagePublisher, MessageSubscriber {
  private transports: Map<string, Transport> = new Map();
  private options: ClientOptions;

  constructor(options: ClientOptions) {
    this.options = options;
  }

  registerTransport(transport: Transport): void {
    this.transports.set(transport.name, transport);
  }

  unregisterTransport(name: string): boolean {
    return this.transports.delete(name);
  }

  getTransport(name: string): Transport | undefined {
    return this.transports.get(name);
  }

  async call<TInput, TOutput>(service: string, method: string, input: TInput): Promise<TOutput> {
    const transport = this.getRpcTransport();
    if (!transport) {
      throw new Error('No RPC transport available');
    }

    const rpcClient = transport as unknown as RpcClient;
    return rpcClient.call(service, method, input);
  }

  stream<TInput, TOutput>(service: string, method: string, input: TInput): AsyncIterable<TOutput> {
    const transport = this.getRpcTransport();
    if (!transport) {
      throw new Error('No RPC transport available');
    }

    const rpcClient = transport as unknown as RpcClient;
    return rpcClient.stream(service, method, input);
  }

  async publish(topic: string, message: unknown, options?: { key?: string; headers?: Record<string, string> }): Promise<void> {
    const transport = this.getMessagingTransport();
    if (!transport) {
      throw new Error('No messaging transport available');
    }

    const publisher = transport as unknown as MessagePublisher;
    return publisher.publish(topic, message, options);
  }

  async subscribe(topic: string, handler: (message: unknown, context: { topic: string }) => Promise<void>, options?: { groupId?: string }): Promise<void> {
    const transport = this.getMessagingTransport();
    if (!transport) {
      throw new Error('No messaging transport available');
    }

    const subscriber = transport as unknown as MessageSubscriber;
    return subscriber.subscribe(topic, handler, options);
  }

  async unsubscribe(topic: string): Promise<void> {
    const transport = this.getMessagingTransport();
    if (!transport) {
      throw new Error('No messaging transport available');
    }

    const subscriber = transport as unknown as MessageSubscriber;
    return subscriber.unsubscribe(topic);
  }

  private getRpcTransport(): Transport | undefined {
    for (const transport of this.transports.values()) {
      if (transport.capabilities.requestResponse) {
        return transport;
      }
    }
    return undefined;
  }

  private getMessagingTransport(): Transport | undefined {
    for (const transport of this.transports.values()) {
      if (transport.capabilities.publishSubscribe) {
        return transport;
      }
    }
    return undefined;
  }
}

export function createClient(options: ClientOptions): MicroserviceClient {
  return new MicroserviceClient(options);
}