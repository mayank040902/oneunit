import { BaseTransport, TransportConfig } from '@/transport/transport';
import { TransportCapabilities, TransportHealth, RpcClient, RpcServer, RpcContext, RpcMethodHandler } from '@/core/capabilities';

export interface ConnectConfig {
  endpoint: string;
  transport: any;
  services: Map<string, any>;
  interceptors?: any[];
}

export class ConnectTransport extends BaseTransport implements RpcClient, RpcServer {
  private config: ConnectConfig;
  private client: any;
  private server: any;
  private methodHandlers: Map<string, Map<string, RpcMethodHandler>> = new Map();

  constructor(config: ConnectConfig) {
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
  }

  async start(): Promise<void> {
    const { createPromiseClient } = await import('@connectrpc/connect');
    const { createGrpcTransport } = await import('@connectrpc/connect-node');
    
    // Convert Map to proper service definitions for createPromiseClient
    const serviceDefinitions: any = {};
    for (const [name, def] of this.config.services) {
      serviceDefinitions[name] = def;
    }
    
    this.client = createPromiseClient(serviceDefinitions, this.config.transport);
    this.started = true;
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
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

    return serviceClient[method](input);
  }

  async *stream<TInput, TOutput>(service: string, method: string, input: TInput): AsyncIterable<TOutput> {
    if (!this.client) {
      throw new Error('Connect client not initialized');
    }

    const serviceClient = this.client[service];
    if (!serviceClient) {
      throw new Error(`Service ${service} not found`);
    }

    const stream = serviceClient[method](input);
    
    for await (const response of stream) {
      yield response as TOutput;
    }
  }
}

export function createConnectTransport(config: ConnectConfig): ConnectTransport {
  return new ConnectTransport(config);
}