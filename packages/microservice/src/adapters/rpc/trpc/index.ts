import { BaseTransport } from '@/transport/transport';
import { TransportHealth, RpcClient, RpcServer, RpcMethodHandler } from '@/core/capabilities';

export interface TrpcConfig {
  endpoint: string;
  router: unknown;
  cors?: boolean;
}

type TrpcServiceClient = Record<string, (input: unknown) => Promise<unknown>>;

export class TrpcTransport extends BaseTransport implements RpcClient, RpcServer {
  private config: TrpcConfig;
  private methods: Map<string, Map<string, RpcMethodHandler>> = new Map();
  private client: unknown = null;
  private server: unknown = null;

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
    const router = t.router(this.config.router as Parameters<typeof t.router>[0]);

    this.server = createHTTPServer({
      router,
      createContext: () => ({}),
    });

    await (this.server as { listen: (port: string | number) => Promise<void> }).listen(this.config.endpoint as string | number);
    this.started = true;
  }

  async close(): Promise<void> {
    if (this.server) {
      await (this.server as { close: () => Promise<void> }).close();
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

    const serviceClient = (this.client as Record<string, TrpcServiceClient>)[service];
    if (!serviceClient) {
      throw new Error(`Service ${service} not found`);
    }

    const methodClient = serviceClient[method];
    if (!methodClient) {
      throw new Error(`Method ${method} not found on service ${service}`);
    }

    return methodClient(input) as Promise<TOutput>;
  }

  stream<TInput, TOutput>(_service: string, _method: string, _input: TInput): AsyncIterable<TOutput> {
    async function* throwingGenerator(): AsyncIterable<TOutput> {
      throw new Error('Streaming not supported in tRPC transport');
      yield undefined as never;
    }
    return throwingGenerator();
  }
}

export function createTrpcTransport(config: TrpcConfig): TrpcTransport {
  return new TrpcTransport(config);
}