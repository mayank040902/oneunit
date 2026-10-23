import { RpcServer, Transport, RpcMethodHandler, RpcContext } from './capabilities.js';
import { ServiceIdentity } from '../identity/service-identity.js';
import type { Authenticator } from '../identity/authentication.js';
import type { Tracer } from '../observability/tracing.js';
import type { MetricsCollector } from '../observability/metrics.js';
import type { ServiceCredentials } from '../identity/credentials.js';
import { AuthorizationPolicy } from '../identity/authorization.js';
import { createMicroserviceError, ErrorCodes } from './errors.js';
import { AuditLogger } from '../observability/audit.js';
import { createSecuredDispatcher } from './secured-dispatcher.js';
import type { SecuredDispatchOptions, SecuredRequestContext } from './secured-dispatcher.js';

export interface ServerOptions {
  service: ServiceIdentity;
  authorization: AuthorizationPolicy;
  authenticationEnabled?: boolean;
  audit?: AuditLogger;
  authenticator?: Authenticator;
  tracer?: Tracer;
  metrics?: MetricsCollector;
}

export class MicroserviceServer implements RpcServer {
  private transports: Map<string, Transport> = new Map();
  private methods: Map<string, Map<string, RpcMethodHandler>> = new Map();
  private options: ServerOptions;
  private securedDispatcherInstance: ReturnType<typeof createSecuredDispatcher> | undefined;

  constructor(options: ServerOptions) {
    this.options = options;
  }

  private getSecuredDispatcher() {
    if (!this.securedDispatcherInstance) {
      const options: SecuredDispatchOptions = {
        service: this.options.service,
        authorization: this.options.authorization,
        authenticationEnabled: this.options.authenticationEnabled,
        audit: this.options.audit,
        authenticator: this.options.authenticator,
        tracer: this.options.tracer,
        metrics: this.options.metrics,
        transport: 'microservice',
      };
      this.securedDispatcherInstance = createSecuredDispatcher(options);
    }
    return this.securedDispatcherInstance;
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

  registerMethod(service: string, method: string, handler: RpcMethodHandler): void {
    if (!this.methods.has(service)) {
      this.methods.set(service, new Map());
    }
    this.methods.get(service)!.set(method, handler);
  }

  unregisterMethod(service: string, method: string): void {
    this.methods.get(service)?.delete(method);
  }

  getMethodHandler(service: string, method: string): RpcMethodHandler | undefined {
    return this.methods.get(service)?.get(method);
  }

  getAllMethods(): Array<{ service: string; method: string }> {
    const result: Array<{ service: string; method: string }> = [];
    for (const [service, methods] of this.methods) {
      for (const method of methods.keys()) {
        result.push({ service, method });
      }
    }
    return result;
  }

  async handle(service: string, method: string, input: unknown, context: RpcContext): Promise<unknown> {
    const handler = this.getMethodHandler(service, method);
    if (!handler) {
      const metrics = this.options.metrics;
      const labels = { service, method };
      try {
        metrics?.incrementCounter('rpc.requests.total', { ...labels, outcome: 'not_found' });
      } catch {
        // Instrumentation is best-effort.
      }
      throw createMicroserviceError(
        ErrorCodes.NOT_FOUND,
        `Method ${service}.${method} not found`,
        'NOT_FOUND',
        false,
        { details: { service, method } }
      );
    }

    const dispatcher = this.getSecuredDispatcher();
    const request: SecuredRequestContext = {
      service,
      method,
      transport: 'microservice',
      operation: `${service}.${method}`,
      targetService: service,
      credentials: context.metadata.get('credentials') as ServiceCredentials | undefined,
      metadata: context.metadata,
      attributes: {},
      correlationId: context.correlationId,
    };

    return dispatcher.dispatch(request, async () => {
      if (request.principal && context.metadata) {
        context.metadata.set('principal', request.principal);
        context.metadata.set('authenticatedPrincipal', request.principal);
      }
      if (request.caller && context.metadata) {
        context.metadata.set('caller', request.caller);
      }
      return handler(input, context);
    });
  }
}

export function createServer(options: ServerOptions): MicroserviceServer {
  return new MicroserviceServer(options);
}
