import { BaseTransport } from '@/transport/transport';
import { TransportHealth, RpcClient, RpcServer, RpcContext, RpcMethodHandler } from '@/core/capabilities';
import type * as grpc from '@grpc/grpc-js';
import { createMicroserviceError, ErrorCodes } from '@/core/errors.js';
import { resolveSecurity, createSecuredDispatcher } from '@/core/secured-dispatcher.js';
import type { ResolvedSecurity } from '@/core/secured-dispatcher.js';
import type { SecuredRequestContext } from '@/core/secured-dispatcher.js';
import type { ServiceCredentials } from '@/identity/credentials.js';

export interface GrpcConfig {
  endpoint: string;
  protoPath: string;
  packageName: string;
  credentials?: grpc.ChannelCredentials | null;
  tls?: boolean;
  logger?: { error: (...args: unknown[]) => void };
}

export class GrpcTransport extends BaseTransport implements RpcClient, RpcServer {
  private config: GrpcConfig;
  private securityInput: unknown;
  private client: grpc.Client | null = null;
  private server: grpc.Server | null = null;
  private methodHandlers: Map<string, Map<string, RpcMethodHandler>> = new Map();
  private securedDispatcherInstance: ReturnType<typeof createSecuredDispatcher> | null = null;

  constructor(config: GrpcConfig, security?: unknown) {
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
    this.securityInput = security;
  }

  private getSecuredDispatcher() {
    if (this.securedDispatcherInstance) return this.securedDispatcherInstance;
    const resolved = resolveSecurity(this.config, this.securityInput, this) as ResolvedSecurity;
    if (!resolved.protected) return null;
    const dispatcher = resolved.dispatcher ?? (resolved.options ? createSecuredDispatcher(resolved.options) : null);
    this.securedDispatcherInstance = dispatcher;
    return dispatcher;
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
            (this.config.logger ?? console).error('gRPC server shutdown error:', err);
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

  async handle(service: string, method: string, input: unknown, context: RpcContext): Promise<unknown> {
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
    const dispatcher = this.getSecuredDispatcher();
    const metadata = context.metadata instanceof Map ? context.metadata : new Map(Object.entries(context.metadata ?? {}));
    context.metadata = metadata;
    const request: SecuredRequestContext = {
      service,
      method,
      transport: 'grpc',
      operation: `${service}.${method}`,
      targetService: service,
      credentials: metadata.get('credentials') as ServiceCredentials | undefined,
      metadata,
      attributes: {},
      correlationId: context.correlationId,
    };
    const run = () => {
      if (request.principal && metadata) {
        metadata.set('principal', request.principal);
        metadata.set('authenticatedPrincipal', request.principal);
      }
      if (request.caller && metadata) {
        metadata.set('caller', request.caller);
      }
      return handler(input, context);
    };
    if (!dispatcher) {
      return run();
    }
    return dispatcher.dispatch(request, run);
  }

  private createGrpcHandler(handler: RpcMethodHandler, serviceName: string, methodName: string): grpc.UntypedHandleCall {
    return async (call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      try {
        const metadataMap = new Map<string, unknown>();
        const rawMetadata = call?.metadata as { getMap?: () => Record<string, unknown>; get?: (key: string) => unknown } | undefined;
        if (rawMetadata && typeof rawMetadata.getMap === 'function') {
          const mapped = rawMetadata.getMap();
          for (const [key, value] of Object.entries(mapped ?? {})) {
            metadataMap.set(key, value);
          }
        } else if (rawMetadata instanceof Map) {
          for (const [key, value] of rawMetadata) {
            metadataMap.set(String(key), value);
          }
        } else if (rawMetadata && typeof rawMetadata.get === 'function') {
          for (const key of ['credentials', 'correlation-id', 'authorization', 'traceparent']) {
            const value = rawMetadata.get(key);
            const resolved = Array.isArray(value) ? value[0] : value;
            if (resolved !== undefined) metadataMap.set(key, resolved);
          }
        }

        const context: RpcContext = {
          serviceId: serviceName,
          correlationId: (metadataMap.get('correlation-id') as string | undefined) || crypto.randomUUID(),
          headers: {},
          metadata: metadataMap,
        };

        const dispatcher = this.getSecuredDispatcher();
        const credentials = metadataMap.get('credentials') as ServiceCredentials | undefined;
        const request: SecuredRequestContext = {
          service: serviceName,
          method: methodName,
          transport: 'grpc',
          operation: `${serviceName}.${methodName}`,
          targetService: serviceName,
          credentials,
          metadata: metadataMap,
          attributes: {},
          correlationId: context.correlationId,
        };

        const run = async () => {
          if (request.principal && metadataMap) {
            metadataMap.set('principal', request.principal);
            metadataMap.set('authenticatedPrincipal', request.principal);
          }
          if (request.caller && metadataMap) {
            metadataMap.set('caller', request.caller);
          }
          return handler(call.request, context);
        };

        const result = dispatcher ? await dispatcher.dispatch(request, run) : await run();
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