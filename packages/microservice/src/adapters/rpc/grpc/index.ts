import { BaseTransport } from '@/transport/transport';
import { TransportHealth, RpcClient, RpcServer, RpcContext, RpcMethodHandler } from '@/core/capabilities';
import type * as grpc from '@grpc/grpc-js';

export interface GrpcConfig {
  endpoint: string;
  protoPath: string;
  packageName: string;
  credentials?: grpc.ChannelCredentials | null;
  tls?: boolean;
}

export class GrpcTransport extends BaseTransport implements RpcClient, RpcServer {
  private config: GrpcConfig;
  private client: grpc.Client | null = null;
  private server: grpc.Server | null = null;
  private serviceDefinitions: Map<string, grpc.ServiceDefinition | grpc.ProtobufTypeDefinition> = new Map();
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
    const service = proto[this.config.packageName] as Record<string, grpc.ServiceClientConstructor | grpc.ProtobufTypeDefinition | grpc.GrpcObject>;

    this.server = new grpc.Server();

    for (const [serviceName, methods] of this.methodHandlers) {
      const serviceDef = service[serviceName];
      if (serviceDef && (serviceDef as grpc.ServiceClientConstructor).service) {
        const handlers: grpc.UntypedServiceImplementation = {};
        for (const [methodName, handler] of methods) {
          handlers[methodName] = this.createGrpcHandler(handler, serviceName, methodName);
        }
        this.server.addService((serviceDef as grpc.ServiceClientConstructor).service, handlers);
      }
    }

    const address = this.config.endpoint;
    const creds = this.config.tls
      ? grpc.ServerCredentials.createSsl(null, [], true)
      : grpc.ServerCredentials.createInsecure();

    await new Promise<void>((resolve, reject) => {
      this.server!.bindAsync(address, creds, (err: Error | null) => {
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
        this.server!.tryShutdown((err?: Error) => {
          if (err) {
            console.error('gRPC server shutdown error:', err);
          }
          resolve();
        });
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

  private createGrpcHandler(handler: RpcMethodHandler, _serviceName: string, _methodName: string): grpc.UntypedHandleCall {
    return async (call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      try {
        const context: RpcContext = {
          serviceId: _serviceName,
          correlationId: (call.metadata.get('correlation-id')?.[0] as string | undefined) || crypto.randomUUID(),
          headers: {},
          metadata: new Map(),
        };

        const result = await handler(call.request, context);
        callback(null, result);
      } catch (err) {
        callback(err as grpc.ServiceError, null);
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
      const serviceDef = proto[this.config.packageName] as Record<string, grpc.ServiceClientConstructor | grpc.ProtobufTypeDefinition | grpc.GrpcObject>;

      const creds = this.config.tls
        ? grpc.credentials.createSsl()
        : grpc.credentials.createInsecure();

      const ServiceConstructor = serviceDef[service] as grpc.ServiceClientConstructor | undefined;
      if (!ServiceConstructor) {
        throw new Error(`Service ${service} not found`);
      }

      this.client = new ServiceConstructor(this.config.endpoint, creds);
    }

    const serviceClient = this.client as unknown as Record<string, (...args: unknown[]) => unknown>;
    if (!serviceClient) {
      throw new Error(`Service ${service} not found`);
    }

    return new Promise<TOutput>((resolve, reject) => {
      // ServiceClient exposes each method via an index signature of
      // `Function`; call it with the standard unary callback.
      // Must use .call() to preserve `this` context on the client.
      const fn = serviceClient[method];
      if (!fn) {
        reject(new Error(`Method ${method} not found on service ${service}`));
        return;
      }
      fn.call(serviceClient, input, (err: grpc.ServiceError | null, response: unknown) => {
        if (err) reject(err);
        else resolve(response as TOutput);
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
      const serviceDef = proto[this.config.packageName] as Record<string, grpc.ServiceClientConstructor | grpc.ProtobufTypeDefinition | grpc.GrpcObject>;

      const creds = this.config.tls
        ? grpc.credentials.createSsl()
        : grpc.credentials.createInsecure();

      const ServiceConstructor = serviceDef[service] as grpc.ServiceClientConstructor | undefined;
      if (!ServiceConstructor) {
        throw new Error(`Service ${service} not found`);
      }

      this.client = new ServiceConstructor(this.config.endpoint, creds);
    }

    const serviceClient = this.client as unknown as Record<string, (input: unknown) => grpc.ClientReadableStream<unknown>>;
    if (!serviceClient) {
      throw new Error(`Service ${service} not found`);
    }

    const streamFn = serviceClient[method];
    if (!streamFn) {
      throw new Error(`Method ${method} not found on service ${service}`);
    }

    const call = streamFn(input);

    for await (const response of call) {
      yield response as TOutput;
    }
  }
}

export function createGrpcTransport(config: GrpcConfig): GrpcTransport {
  return new GrpcTransport(config);
}