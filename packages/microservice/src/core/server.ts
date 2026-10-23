import { RpcServer, Transport, RpcMethodHandler, RpcContext } from './capabilities.js';
import { ServiceIdentity } from '../identity/service-identity.js';
import { AuthorizationPolicy } from '../identity/authorization.js';
import { createMicroserviceError, ErrorCodes, isMicroserviceError, sanitizeErrorDetails } from './errors.js';
import { AuditEventTypes, AuditLogger } from '../observability/audit.js';

export interface ServerOptions {
  service: ServiceIdentity;
  authorization: AuthorizationPolicy;
  authenticationEnabled?: boolean;
  audit?: AuditLogger;
}

export class MicroserviceServer implements RpcServer {
  private transports: Map<string, Transport> = new Map();
  private methods: Map<string, Map<string, RpcMethodHandler>> = new Map();
  private options: ServerOptions;

  constructor(options: ServerOptions) {
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
    // Step 1: Method lookup
    const handler = this.getMethodHandler(service, method);
    if (!handler) {
      throw createMicroserviceError(
        ErrorCodes.NOT_FOUND,
        `Method ${service}.${method} not found`,
        'NOT_FOUND',
        false,
        { details: { service, method } }
      );
    }

    // Step 2: Authorization check (skipped when authentication is disabled)
    if (this.options.authenticationEnabled !== false) {
      const decision = await this.options.authorization.evaluate({
        caller: this.options.service,
        targetService: service,
        operation: `${service}.${method}`,
        resource: method,
        attributes: {},
      });

      if (!decision.allowed) {
      // Audit the authorization denial.
      if (this.options.audit) {
        try {
          await this.options.audit.log({
            eventId: `authz-${Date.now()}`,
            eventType: AuditEventTypes.AUTHORIZATION_DENIED,
            timestamp: Date.now(),
            actor: { serviceId: this.options.service.serviceId, instanceId: this.options.service.instanceId },
            action: 'call',
            resource: { type: 'method', id: `${service}.${method}` },
            outcome: 'failure',
            details: { service, method, reason: decision.reason },
            riskLevel: 'high',
          });
        } catch {
          // Audit logging must not block the request path.
        }
      }

      throw createMicroserviceError(
        ErrorCodes.FORBIDDEN,
        decision.reason ?? `Authorization denied for ${service}.${method}`,
        'AUTHORIZATION',
        false,
        { details: { service, method, reason: decision.reason } }
      );
      }
    }

    // Step 3: Execute the handler
    try {
      return await handler(input, context);
    } catch (err) {
      if (isMicroserviceError(err)) {
        throw err;
      }
      throw createMicroserviceError(
        ErrorCodes.INTERNAL,
        err instanceof Error ? err.message : String(err),
        'INTERNAL',
        false,
        {
          details: { service, method, originalError: sanitizeErrorDetails(err) },
        },
      );
    }
  }
}

export function createServer(options: ServerOptions): MicroserviceServer {
  return new MicroserviceServer(options);
}