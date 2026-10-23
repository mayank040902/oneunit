import { RpcClient, MessagePublisher, MessageSubscriber, Transport } from './capabilities.js';
import { ServiceIdentity } from '../identity/service-identity.js';
import { AuthorizationPolicy } from '../identity/authorization.js';
import { createMicroserviceError, ErrorCodes, getErrorCategory, isMicroserviceError } from './errors.js';

export interface CallOptions {
  timeout?: number;
  idempotent?: boolean;
}

export interface ClientOptions {
  service: ServiceIdentity;
  authorization: AuthorizationPolicy;
  authenticationEnabled?: boolean;
  defaultTimeout?: number;
  retryPolicy?: RetryPolicy;
}

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  retryableCategories: string[];
  idempotent?: boolean;
  deadlineMs?: number;
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

  async call<TInput, TOutput>(service: string, method: string, input: TInput, callOptions: CallOptions = {}): Promise<TOutput> {
    const transport = this.getRpcTransport();
    if (!transport) {
      throw new Error('No RPC transport available');
    }

    if (!implementsRpcClient(transport)) {
      throw new Error(
        `Transport ${transport.name} advertises requestResponse but does not implement RPC call/stream`,
      );
    }

    if (this.options.authenticationEnabled !== false) {
      const decision = await this.options.authorization.evaluate({
        caller: this.options.service,
        targetService: service,
        operation: `${service}.${method}`,
        resource: method,
        attributes: {},
      });
      if (!decision.allowed) {
        throw createMicroserviceError(
          ErrorCodes.FORBIDDEN,
          decision.reason ?? `Outbound call to ${service}.${method} is not authorized`,
          'AUTHORIZATION',
          false,
          { details: { service, method, reason: decision.reason } },
        );
      }
    }

    const timeoutMs = callOptions.timeout ?? this.options.defaultTimeout;
    const operation = (): Promise<TOutput> => transport.call<TInput, TOutput>(service, method, input);

    const makeTimedOperation = (): (() => Promise<TOutput>) => {
      return async () => {
        const op = operation();
        // Swallow late rejections so they never become unhandled rejections
        // after the timeout has already settled the outer promise.
        void op.catch(() => {});

        let timer: NodeJS.Timeout | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timer = null;
            reject(
              createMicroserviceError(
                ErrorCodes.TIMEOUT,
                `RPC call to ${service}.${method} timed out after ${timeoutMs}ms`,
                'TIMEOUT',
                true,
                { details: { service, method, timeoutMs } },
              ),
            );
          }, timeoutMs!);
        });
        // Attach a rejection handler synchronously so the timeout promise is
        // never reported as unhandled, even under fake timers.
        void timeoutPromise.catch(() => {});

        try {
          return await Promise.race([op, timeoutPromise]);
        } finally {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
        }
      };
    };

    const baseOperation = timeoutMs ? makeTimedOperation() : operation;

    let resultPromise: Promise<TOutput>;
    if (!this.options.retryPolicy) {
      resultPromise = baseOperation();
    } else {
      const rp = callOptions.idempotent !== undefined
        ? { ...this.options.retryPolicy, idempotent: callOptions.idempotent }
        : this.options.retryPolicy;
      resultPromise = this.executeWithRetry(baseOperation, rp, service, method);
    }

    // Attach a non-consuming rejection handler synchronously so a timed-out
    // operation whose transport does not reject immediately can never surface as
    // an unhandled promise rejection, while callers still observe rejection on
    // the exact promise returned above.
    void resultPromise.catch(() => {});
    return resultPromise;
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
    policy: RetryPolicy,
    _service?: string,
    _method?: string
  ): Promise<T> {
    const { maxRetries, baseDelayMs, maxDelayMs, jitter, retryableCategories, idempotent, deadlineMs } = policy;

    if (idempotent === false) {
      return operation();
    }

    const deadline = deadlineMs ? Date.now() + deadlineMs : undefined;
    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (err) {
        const category = isMicroserviceError(err) ? getErrorCategory(err) : undefined;
        const errRetryable = isMicroserviceError(err) ? err.retryable : true;
        const retryable = errRetryable !== false && category !== undefined && retryableCategories.includes(category);
        if (!retryable || attempt >= maxRetries) {
          throw err;
        }
        if (deadline && Date.now() >= deadline) {
          throw err;
        }

        const exponential = baseDelayMs * 2 ** attempt;
        const capped = Math.min(exponential, maxDelayMs);
        let delay = jitter ? capped * (0.5 + Math.random()) : capped;
        if (deadline) {
          if (Date.now() + delay > deadline) {
            throw err;
          }
          delay = Math.min(delay, Math.max(0, deadline - Date.now()));
        }
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
