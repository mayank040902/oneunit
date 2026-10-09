import { RpcServer, Transport } from './capabilities.js';
import { ServiceIdentity } from '../identity/service-identity.js';
import { AuthorizationPolicy } from '../identity/authorization.js';

export interface ServerOptions {
  service: ServiceIdentity;
  authorization: AuthorizationPolicy;
}

export class MicroserviceServer implements RpcServer {
  private transports: Map<string, Transport> = new Map();
  private methods: Map<string, Map<string, (input: unknown, context: any) => Promise<unknown>>> = new Map();
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

  registerMethod(service: string, method: string, handler: (input: unknown, context: any) => Promise<unknown>): void {
    if (!this.methods.has(service)) {
      this.methods.set(service, new Map());
    }
    this.methods.get(service)!.set(method, handler);
  }

  unregisterMethod(service: string, method: string): void {
    this.methods.get(service)?.delete(method);
  }

  getMethodHandler(service: string, method: string): ((input: unknown, context: any) => Promise<unknown>) | undefined {
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
}

export function createServer(options: ServerOptions): MicroserviceServer {
  return new MicroserviceServer(options);
}