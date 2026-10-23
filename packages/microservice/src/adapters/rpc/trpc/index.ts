import { BaseTransport } from '@/transport/transport';
import { TransportHealth, RpcClient, RpcServer, RpcMethodHandler } from '@/core/capabilities';
import { createMicroserviceError, ErrorCodes } from '@/core/errors.js';
import { resolveSecurity, createSecuredDispatcher } from '@/core/secured-dispatcher.js';
import type { ResolvedSecurity } from '@/core/secured-dispatcher.js';
import type { SecuredRequestContext } from '@/core/secured-dispatcher.js';
import type { ServiceCredentials } from '@/identity/credentials.js';

export interface TrpcConfig {
  endpoint: string;
  router: unknown;
  cors?: boolean;
}

type TrpcServiceClient = Record<string, (input: unknown) => Promise<unknown>>;

export class TrpcTransport extends BaseTransport implements RpcClient, RpcServer {
  private config: TrpcConfig;
  private securityInput: unknown;
  private methods: Map<string, Map<string, RpcMethodHandler>> = new Map();
  private client: unknown = null;
  private server: unknown = null;
  private securedDispatcherInstance: ReturnType<typeof createSecuredDispatcher> | null = null;

  private getSecuredDispatcher() {
    if (this.securedDispatcherInstance) return this.securedDispatcherInstance;
    const resolved = resolveSecurity(this.config, this.securityInput, this) as ResolvedSecurity;
    if (!resolved.protected) return null;
    const dispatcher = resolved.dispatcher ?? (resolved.options ? createSecuredDispatcher(resolved.options) : null);
    this.securedDispatcherInstance = dispatcher;
    return dispatcher;
  }

  constructor(config: TrpcConfig, security?: unknown) {
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
    this.securityInput = security;
  }

  private isSecurityRequired(): boolean {
    const si = this.securityInput as Record<string, unknown> | undefined;
    const cfg = this.config as unknown as Record<string, unknown>;
    return !!(si?.['securityRequired'] === true || si?.['requireSecurity'] === true || cfg['securityRequired'] === true || cfg['requireSecurity'] === true);
  }

  private extractTrpcCredentials(req: unknown, input: unknown): unknown {
    const request = req as Record<string, unknown> | undefined;
    const headers = (request?.['headers'] as Record<string, unknown> | undefined) ?? {};
    let credentials = headers['x-service-credentials'] ?? headers['x-credentials'] ?? headers['credentials'] ?? headers['authorization'] ?? headers['x-authorization'];
    if (typeof credentials === 'string') {
      try { credentials = JSON.parse(credentials); } catch { void 0; }
    }
    if (credentials === undefined && input && typeof input === 'object' && !Array.isArray(input)) {
      const record = input as Record<string, unknown>;
      credentials = record['credentials'] ?? record['creds'];
    }
    return credentials;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    const { initTRPC } = await import('@trpc/server');
    const { createHTTPServer } = await import('@trpc/server/adapters/standalone');

    const router = this.config.router as Record<string, unknown> | undefined;
    const t = initTRPC.context<{ req?: unknown; res?: unknown }>().create();

    const securityMiddleware = t.middleware(async (opts) => {
      const meta = (opts?.meta ?? {}) as Record<string, unknown>;
      const path = String(opts?.path ?? '');
      const isPublic = meta['public'] === true || meta['isPublic'] === true || meta['security'] === 'public' ||
        meta['access'] === 'public' || meta['health'] === true || meta['publicProcedure'] === true ||
        /^(health|healthcheck|health-check|health_check|ready|readyz|live|liveness)([./].*)?$/i.test(path);

      if (isPublic) {
        return opts.next();
      }

      const dispatcher = this.getSecuredDispatcher();
      if (!dispatcher) {
        if (this.isSecurityRequired()) {
          throw new Error(`Security required but not configured for ${path}`);
        }
        return opts.next();
      }

      const input = opts.input;
      const optsCtx = (opts?.ctx ?? {}) as Record<string, unknown>;
      const req = optsCtx['req'];
      const credentials = this.extractTrpcCredentials(req, input);
      const metadata = new Map<string, unknown>();
      const headers = (((req as { headers?: unknown } | undefined)?.headers) ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(headers)) {
        metadata.set(key, value);
      }
      if (credentials !== undefined) {
        metadata.set('credentials', credentials);
      }

      const request = {
        service: 'trpc',
        method: path,
        transport: 'trpc',
        operation: `trpc.${path}`,
        targetService: path,
        credentials,
        metadata,
        attributes: {},
        correlationId: (typeof headers['x-correlation-id'] === 'string' ? headers['x-correlation-id'] : undefined) ?? crypto.randomUUID(),
      };

      return dispatcher.dispatch(request as SecuredRequestContext, async () => {
        const principal = (request as Record<string, unknown>)['principal'];
        const caller = (request as Record<string, unknown>)['caller'];
        return opts.next({ ctx: { ...opts.ctx, principal, caller } });
      });
    });

    const rebuildProcedure = (procedure: unknown): unknown => {
      const def = (procedure as Record<string, unknown>)?.['_def'] as Record<string, unknown> | undefined;
      if (!def || typeof def['resolver'] !== 'function') return procedure;
      let builder = t.procedure;
      const middlewares = (def['middlewares'] as unknown[]) ?? [];
      for (const mw of middlewares) {
        if (typeof mw === 'function' && !String(mw).startsWith('async function resolveMiddleware')) {
          builder = (builder as unknown as { use: (mw: unknown) => typeof builder }).use(mw) as typeof builder;
        }
      }
      builder = (builder as unknown as { use: (mw: unknown) => typeof builder }).use(securityMiddleware) as typeof builder;
      const inputs = (def['inputs'] as unknown[]) ?? [];
      for (const input of inputs) {
        if (input) builder = (builder as unknown as { input: (schema: unknown) => typeof builder }).input(input) as typeof builder;
      }
      const meta = def['meta'] as Record<string, unknown> | undefined;
      if (meta) builder = (builder as unknown as { meta: (m: unknown) => typeof builder }).meta(meta) as typeof builder;
      if (def['type'] === 'query') return (builder as unknown as { query: (r: unknown) => unknown }).query(def['resolver']);
      if (def['type'] === 'mutation') return (builder as unknown as { mutation: (r: unknown) => unknown }).mutation(def['resolver']);
      if (def['type'] === 'subscription') return (builder as unknown as { subscription: (r: unknown) => unknown }).subscription(def['resolver']);
      return procedure;
    };

    const rebuildRouter = (value: unknown): unknown => {
      const def = (value as Record<string, unknown>)?.['_def'] as Record<string, unknown> | undefined;
      if (!def || !def['record'] || typeof def['record'] !== 'object') return value;
      const record = def['record'] as Record<string, unknown>;
      const newRecord: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(record)) {
        const childDef = (child as Record<string, unknown>)?.['_def'] as Record<string, unknown> | undefined;
        if (childDef && childDef['record']) {
          newRecord[key] = rebuildRouter(child);
        } else {
          newRecord[key] = rebuildProcedure(child);
        }
      }
      return t.router(newRecord as never);
    };

    let securedRouter: unknown = router;
    if (router && typeof router === 'object' && (router as Record<string, unknown>)['_def']) {
      securedRouter = rebuildRouter(router);

    }

    let host = '0.0.0.0';
    let port: number | string = this.config.endpoint as string | number;
    let basePath = '/';
    const endpoint = this.config.endpoint;
    if (typeof endpoint === 'string') {
      try {
        const url = new URL(endpoint.includes('://') ? endpoint : `http://${endpoint}`);
        if (url.hostname) host = url.hostname;
        if (url.port) port = Number(url.port);
        if (url.pathname && url.pathname !== '/') basePath = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
      } catch {
        const idx = endpoint.lastIndexOf(':');
        if (idx > -1) {
          host = endpoint.slice(0, idx) || host;
          const parsed = Number(endpoint.slice(idx + 1));
          if (!Number.isNaN(parsed)) port = parsed;
        }
      }
    }
    if (typeof port === 'string') {
      const parsed = Number(port);
      if (!Number.isNaN(parsed)) port = parsed;
    }

    const createHttpServerFn = createHTTPServer as unknown as (opts: Record<string, unknown>) => unknown;
    this.server = createHttpServerFn({
      router: securedRouter ?? t.router({}),
      createContext: ({ req, res }: { req: unknown; res: unknown }) => ({ req, res }),
      basePath,
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server as { listen: (...args: unknown[]) => unknown };
      const cb = (err?: Error) => (err ? reject(err) : resolve());
      if (typeof port === 'number') server.listen(port, host, cb);
      else server.listen(port, cb);
    });
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

  async handle(service: string, method: string, input: unknown, context: unknown): Promise<unknown> {
    const handlers = this.methods.get(service);
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
    const rpcContext = context as import('@/core/capabilities').RpcContext;
    const dispatcher = this.getSecuredDispatcher();
    const metadata = rpcContext.metadata instanceof Map ? rpcContext.metadata : new Map(Object.entries(rpcContext.metadata ?? {}));
    rpcContext.metadata = metadata;
    const request: SecuredRequestContext = {
      service,
      method,
      transport: 'trpc',
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