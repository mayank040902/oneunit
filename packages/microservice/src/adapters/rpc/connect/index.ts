import { BaseTransport } from '@/transport/transport';
import { TransportHealth, RpcClient, RpcServer, RpcMethodHandler } from '@/core/capabilities.js';
import type { ServiceType } from '@bufbuild/protobuf';
import type { Transport } from '@connectrpc/connect';
import { createMicroserviceError, ErrorCodes } from '@/core/errors.js';
import { resolveSecurity, createSecuredDispatcher } from '@/core/secured-dispatcher.js';
import type { ResolvedSecurity } from '@/core/secured-dispatcher.js';
import type { SecuredRequestContext } from '@/core/secured-dispatcher.js';
import type { ServiceCredentials } from '@/identity/credentials.js';

export interface ConnectConfig {
  endpoint: string;
  transport: unknown;
  services: Map<string, unknown>;
  interceptors?: unknown[];
}

type ConnectServiceClient = Record<string, (input: unknown) => unknown | AsyncIterable<unknown>>;

export class ConnectTransport extends BaseTransport implements RpcClient, RpcServer {
  private config: ConnectConfig;
  private securityInput: unknown;
  private client: Record<string, ConnectServiceClient> | null = null;
  private methodHandlers: Map<string, Map<string, RpcMethodHandler>> = new Map();
  private securedDispatcherInstance: ReturnType<typeof createSecuredDispatcher> | null = null;

  private getSecuredDispatcher() {
    if (this.securedDispatcherInstance) return this.securedDispatcherInstance;
    const resolved = resolveSecurity(this.config, this.securityInput, this) as ResolvedSecurity;
    if (!resolved.protected) return null;
    const dispatcher = resolved.dispatcher ?? (resolved.options ? createSecuredDispatcher(resolved.options) : null);
    this.securedDispatcherInstance = dispatcher;
    return dispatcher;
  }

  constructor(config: ConnectConfig, security?: unknown) {
    super({
      name: 'connect',
      capabilities: {
        requestResponse: true,
        streaming: true,
        publishSubscribe: false,
        durableDelivery: false,
        orderedDelivery: true,
        bidirectional: true,
      },
    });
    this.config = config;
    this.securityInput = security;
  }

  async start(): Promise<void> {
    const { createPromiseClient } = await import('@connectrpc/connect');

    const serviceDefinitions: Record<string, unknown> = {};
    for (const [name, def] of this.config.services) {
      serviceDefinitions[name] = def;
    }

    this.client = createPromiseClient(
      serviceDefinitions as unknown as ServiceType,
      this.config.transport as Transport,
    ) as unknown as Record<string, ConnectServiceClient>;
    this.started = true;
  }

  async close(): Promise<void> {
    if (this.client) {
      await (this.client as unknown as { close(): Promise<void> }).close();
    }
    this.started = false;
  }

  async healthCheck(): Promise<TransportHealth> {
    return {
      status: this.isStarted() ? 'healthy' : 'unhealthy',
      checkedAt: Date.now(),
    };
  }

  registerMethod(service: string, method: string, handler: RpcMethodHandler): void {
    if (!this.methodHandlers.has(service)) {
      this.methodHandlers.set(service, new Map());
    }
    this.methodHandlers.get(service)!.set(method, handler);
  }

  unregisterMethod(service: string, method: string): void {
    this.methodHandlers.get(service)?.delete(method);
  }

  async call<TInput, TOutput>(service: string, method: string, input: TInput): Promise<TOutput> {
    if (!this.client) {
      throw new Error('Connect client not initialized');
    }

    const serviceClient = this.client[service];
    if (!serviceClient) {
      throw new Error(`Service ${service} not found`);
    }

    const methodClient = serviceClient[method];
    if (!methodClient) {
      throw new Error(`Method ${method} not found on service ${service}`);
    }

    return methodClient(input) as Promise<TOutput>;
  }

  async handle(service: string, method: string, input: unknown, context: unknown): Promise<unknown> {
    const handlers = this.methodHandlers.get(service);
    const handler = handlers?.get(method);
    if (!handler) {
      throw createMicroserviceError(
        ErrorCodes.NOT_FOUND,
        `Method ${service}.${method} not found`,
        'NOT_FOUND',
        false,
        { details: { service, method } }
      );
    }
    const rpcContext = context as import('@/core/capabilities.js').RpcContext;
    const dispatcher = this.getSecuredDispatcher();
    const metadata = rpcContext.metadata instanceof Map ? rpcContext.metadata : new Map(Object.entries(rpcContext.metadata ?? {}));
    rpcContext.metadata = metadata;
    const request: SecuredRequestContext = {
      service,
      method,
      transport: 'connect',
      operation: `${service}.${method}`,
      targetService: service,
      credentials: metadata.get('credentials') as ServiceCredentials | undefined,
      metadata,
      attributes: {},
      correlationId: rpcContext.correlationId,
    };
    const run = () => {
      if (request.principal && metadata) {
        metadata.set('principal', request.principal);
        metadata.set('authenticatedPrincipal', request.principal);
      }
      if (request.caller && metadata) {
        metadata.set('caller', request.caller);
      }
      return handler(input, rpcContext);
    };
    if (!dispatcher) {
      return run();
    }
    return dispatcher.dispatch(request, run);
  }

  async *stream<TInput, TOutput>(service: string, method: string, input: TInput): AsyncIterable<TOutput> {
    if (!this.client) {
      throw new Error('Connect client not initialized');
    }

    const serviceClient = this.client[service];
    if (!serviceClient) {
      throw new Error(`Service ${service} not found`);
    }

    const methodClient = serviceClient[method];
    if (!methodClient) {
      throw new Error(`Method ${method} not found on service ${service}`);
    }

    const stream = methodClient(input) as AsyncIterable<TOutput>;

    for await (const response of stream) {
      yield response;
    }
  }
}

export function createConnectTransport(config: ConnectConfig): ConnectTransport {
  return new ConnectTransport(config);
}