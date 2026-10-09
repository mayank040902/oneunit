import { BaseTransport, TransportConfig } from '@/transport/transport';
import { TransportCapabilities, TransportHealth, RpcClient, RpcServer, RpcContext, RpcMethodHandler, TransportMetrics } from '@/core/capabilities';

export interface TrpcConfig {
  endpoint: string;
  router: any;
  cors?: boolean;
}

export class TrpcTransport extends BaseTransport implements RpcClient, RpcServer {
  private config: TrpcConfig;
  private methods: Map<string, Map<string, RpcMethodHandler>> = new Map();
  private client: any;
  private server: any;

  constructor(config: TrpcConfig) {
    super({
      name: 'trpc',
      capabilities: {
        requestResponse: true,
        streaming: false,
        publishSubscribe: false,
        durableDelivery: false,
        orderedDelivery: true,
        bidirectional: false,
      },
    });
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    const { initTRPC } = await import('@trpc/server');
    const { createHTTPServer } = await import('@trpc/server/adapters/standalone');
    
    const t = initTRPC.create();
    const router = t.router(this.config.router);
    
    this.server = createHTTPServer({
      router,
      createContext: () => ({}),
    });

    await this.server.listen(this.config.endpoint);
    this.started = true;
  }

  async close(): Promise<void> {
    if (this.server) {
      await this.server.close();
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
    if (!this.methods.has(service)) {
      this.methods.set(service, new Map());
    }
    this.methods.get(service)!.set(method, handler);
  }

  unregisterMethod(service: string, method: string): void {
    this.methods.get(service)?.delete(method);
  }

  async call<TInput, TOutput>(service: string, method: string, input: TInput): Promise<TOutput> {
    if (!this.client) {
      const { createTRPCProxyClient, httpBatchLink } = await import('@trpc/client');
      this.client = createTRPCProxyClient({
        links: [httpBatchLink({ url: this.config.endpoint })],
      });
    }

    const serviceClient = this.client[service];
    if (!serviceClient) {
      throw new Error(`Service ${service} not found`);
    }

    return serviceClient[method](input);
  }

  async *stream<TInput, TOutput>(service: string, method: string, input: TInput): AsyncIterable<TOutput> {
    throw new Error('Streaming not supported in tRPC transport');
  }
}

export function createTrpcTransport(config: TrpcConfig): TrpcTransport {
  return new TrpcTransport(config);
}