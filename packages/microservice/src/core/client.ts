import { RpcClient, MessagePublisher, MessageSubscriber, Transport } from './capabilities.js';
import { ServiceIdentity } from '../identity/service-identity.js';
import { AuthorizationPolicy } from '../identity/authorization.js';
import { getErrorCategory, isMicroserviceError } from './errors.js';

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

// Retry safety: a retried call may execute more
// than once at the remote service. Configure a
// retry policy only for idempotent operations;
// callers needing exactly-once semantics must
// implement operation-level idempotency keys.

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Capability flags are self-reported by transports. These
// guards verify the selected transport actually implements
// the required interface at runtime before it is used, so
// an over-advertised capability fails with a clear error
// instead of an unchecked-cast TypeError.
function implementsRpcClient(transport: Transport): transport is Transport & RpcClient {
  const candidate = transport as unknown as RpcClient;
  return typeof candidate.call === 'function' && typeof candidate.stream === 'function';
}

function implementsMessagePublisher(transport: Transport): transport is Transport & MessagePublisher {
  return typeof (transport as unknown as MessagePublisher).publish === 'function';
}

function implementsMessageSubscriber(transport: Transport): transport is Transport & MessageSubscriber {
  const candidate = transport as unknown as MessageSubscriber;
  return typeof candidate.subscribe === 'function' && typeof candidate.unsubscribe === 'function';
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

    if (!implementsRpcClient(transport)) {
      throw new Error(
        `Transport ${transport.name} advertises requestResponse but does not implement RPC call/stream`,
      );
    }

    if (!this.options.retryPolicy) {
      return transport.call(service, method, input);
    }

    return this.executeWithRetry(
      () => transport.call<TInput, TOutput>(service, method, input),
      this.options.retryPolicy,
    );
  }

  stream<TInput, TOutput>(service: string, method: string, input: TInput): AsyncIterable<TOutput> {
    const transport = this.getRpcTransport();
    if (!transport) {
      throw new Error('No RPC transport available');
    }

    if (!implementsRpcClient(transport)) {
      throw new Error(
        `Transport ${transport.name} advertises requestResponse but does not implement RPC call/stream`,
      );
    }

    return transport.stream(service, method, input);
  }

  async publish(topic: string, message: unknown, options?: { key?: string; headers?: Record<string, string> }): Promise<void> {
    const transport = this.getMessagingTransport();
    if (!transport) {
      throw new Error('No messaging transport available');
    }

    if (!implementsMessagePublisher(transport)) {
      throw new Error(
        `Transport ${transport.name} advertises publishSubscribe but does not implement publish`,
      );
    }

    return transport.publish(topic, message, options);
  }

  async subscribe(topic: string, handler: (message: unknown, context: { topic: string }) => Promise<void>, options?: { groupId?: string }): Promise<void> {
    const transport = this.getMessagingTransport();
    if (!transport) {
      throw new Error('No messaging transport available');
    }

    if (!implementsMessageSubscriber(transport)) {
      throw new Error(
        `Transport ${transport.name} advertises publishSubscribe but does not implement subscribe/unsubscribe`,
      );
    }

    return transport.subscribe(topic, handler, options);
  }

  async unsubscribe(topic: string): Promise<void> {
    const transport = this.getMessagingTransport();
    if (!transport) {
      throw new Error('No messaging transport available');
    }

    if (!implementsMessageSubscriber(transport)) {
      throw new Error(
        `Transport ${transport.name} advertises publishSubscribe but does not implement subscribe/unsubscribe`,
      );
    }

    return transport.unsubscribe(topic);
  }

  // Bounded retry with exponential backoff and
  // optional jitter. Only errors whose normalized
  // category is listed in the policy are retried;
  // permanent failures and errors outside the
  // normalized error model fail fast. Retries are
  // applied to request/response calls only: messaging
  // publishes are non-idempotent and are never
  // blindly retried (§reliability rules).
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    policy: RetryPolicy
  ): Promise<T> {
    const { maxRetries, baseDelayMs, maxDelayMs, jitter, retryableCategories } = policy;

    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (err) {
        const category = isMicroserviceError(err) ? getErrorCategory(err) : undefined;
        const retryable = category !== undefined && retryableCategories.includes(category);
        if (!retryable || attempt >= maxRetries) {
          throw err;
        }

        const exponential = baseDelayMs * 2 ** attempt;
        const capped = Math.min(exponential, maxDelayMs);
        const delay = jitter ? capped * (0.5 + Math.random()) : capped;
        await sleep(delay);
        attempt++;
      }
    }
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
