import { BaseTransport, TransportConfig } from '@/transport/transport';
import { TransportCapabilities, TransportHealth, RpcClient, RpcServer, RpcContext, RpcMethodHandler } from '@/core/capabilities';

export interface GrpcConfig {
  endpoint: string;
  protoPath: string;
  packageName: string;
  credentials?: any;
  tls?: boolean;
}

export class GrpcTransport extends BaseTransport implements RpcClient, RpcServer {
  private config: GrpcConfig;
  private client: any;
  private server: any;
  private serviceDefinitions: Map<string, any> = new Map();
  private methodHandlers: Map<string, Map<string, RpcMethodHandler>> = new Map();

  constructor(config: GrpcConfig) {
    super({
      name: 'grpc',
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
    const grpc = await import('@grpc/grpc-js');
    const protoLoader = await import('@grpc/proto-loader');
    
    const packageDefinition = protoLoader.loadSync(this.config.protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    const proto = grpc.loadPackageDefinition(packageDefinition);
    const service = proto[this.config.packageName] as Record<string, any>;

    this.server = new grpc.Server();
    
    for (const [serviceName, methods] of this.methodHandlers) {
      const serviceDef = service[serviceName];
      if (serviceDef && serviceDef.service) {
        const handlers: Record<string, Function> = {};
        for (const [methodName, handler] of methods) {
          handlers[methodName] = this.createGrpcHandler(handler, serviceName, methodName);
        }
        this.server.addService(serviceDef.service, handlers);
      }
    }

    const address = this.config.endpoint;
    const creds = this.config.tls 
      ? grpc.ServerCredentials.createSsl(null, [], true)
      : grpc.ServerCredentials.createInsecure();
    
    await new Promise<void>((resolve, reject) => {
      this.server.bindAsync(address, creds, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });

    this.server.start();
    this.started = true;
  }

  async close(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server.tryShutdown(resolve);
      });
    }
    if (this.client) {
      this.client.close();
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

  private createGrpcHandler(handler: RpcMethodHandler, serviceName: string, methodName: string) {
    return async (call: any, callback: any) => {
      try {
        const context: RpcContext = {
          serviceId: serviceName,
          correlationId: call.metadata.get('correlation-id')?.[0] || crypto.randomUUID(),
          headers: {},
          metadata: new Map(),
        };

        const result = await handler(call.request, context);
        callback(null, result);
      } catch (err) {
        callback(err, null);
      }
    };
  }

  async call<TInput, TOutput>(service: string, method: string, input: TInput): Promise<TOutput> {
    if (!this.client) {
      const grpc = await import('@grpc/grpc-js');
      const protoLoader = await import('@grpc/proto-loader');
      
      const packageDefinition = protoLoader.loadSync(this.config.protoPath, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      });

      const proto = grpc.loadPackageDefinition(packageDefinition);
      const serviceDef = proto[this.config.packageName] as Record<string, any>;
      
      const creds = this.config.tls
        ? grpc.credentials.createSsl()
        : grpc.credentials.createInsecure();
      
      const ServiceConstructor = serviceDef[service];
      if (!ServiceConstructor) {
        throw new Error(`Service ${service} not found`);
      }
      
      this.client = new ServiceConstructor(this.config.endpoint, creds);
    }

    const serviceClient = this.client;
    if (!serviceClient) {
      throw new Error(`Service ${service} not found`);
    }

    return new Promise((resolve, reject) => {
      serviceClient[method](input, (err: any, response: any) => {
        if (err) reject(err);
        else resolve(response);
      });
    });
  }

  async *stream<TInput, TOutput>(service: string, method: string, input: TInput): AsyncIterable<TOutput> {
    if (!this.client) {
      const grpc = await import('@grpc/grpc-js');
      const protoLoader = await import('@grpc/proto-loader');
      
      const packageDefinition = protoLoader.loadSync(this.config.protoPath, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      });

      const proto = grpc.loadPackageDefinition(packageDefinition);
      const serviceDef = proto[this.config.packageName] as Record<string, any>;
      
      const creds = this.config.tls
        ? grpc.credentials.createSsl()
        : grpc.credentials.createInsecure();
      
      const ServiceConstructor = serviceDef[service];
      if (!ServiceConstructor) {
        throw new Error(`Service ${service} not found`);
      }
      
      this.client = new ServiceConstructor(this.config.endpoint, creds);
    }

    const call = this.client[method](input);
    
    for await (const response of call) {
      yield response as TOutput;
    }
  }
}

export function createGrpcTransport(config: GrpcConfig): GrpcTransport {
  return new GrpcTransport(config);
}