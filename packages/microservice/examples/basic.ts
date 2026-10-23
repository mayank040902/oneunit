// Real-world scenario: an order-processing service that composes the
// microservice application, registers itself with a Redis-backed registry,
// exposes a secured RPC handler, and shuts down gracefully on SIGTERM.
//
// Run with:
//   redis-server --daemonize yes --port 6379 --save "" --appendonly no
//   CRYPTO_ROOT_KEY=$(openssl rand -base64 32) node examples/basic.ts
//
// The example assumes the package is installed in node_modules (e.g. via
// `pnpm add @oneunit/microservice`) so the `@oneunit/microservice` import
// resolves to the published entry point.

import { createMicroservice } from '@oneunit/microservice';
import { createServer } from '@oneunit/microservice';

interface OrderInput {
  customerId: string;
  items: Array<{ sku: string; quantity: number }>;
}

interface OrderOutput {
  orderId: string;
  status: 'accepted' | 'rejected';
  total: number;
}

async function main(): Promise<void> {
  // The root key must be supplied explicitly. In a containerised deployment
  // this comes from a secret manager or the environment, never generated.
  const rootKey = process.env['CRYPTO_ROOT_KEY'];
  if (!rootKey || rootKey.length < 32) {
    throw new Error('CRYPTO_ROOT_KEY must be set (>= 32 characters)');
  }

  // The example defaults to a Redis registry (the production backend) but
  // can be switched to the in-memory backend with REGISTRY_BACKEND=memory
  // so it can be exercised without external infrastructure.
  const registryBackend = process.env['REGISTRY_BACKEND'] ?? 'redis';

  const app = await createMicroservice({
    config: {
      service: {
        id: process.env['SERVICE_ID'] ?? 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        name: 'order-service',
        endpoints: [
          { protocol: 'grpc', host: '0.0.0.0', port: 50051, tls: true },
        ],
        capabilities: ['rpc', 'messaging'],
        metadata: { version: '1.4.2', region: 'us-east-1' },
      },
      registry: {
        backend: registryBackend,
        redis: registryBackend === 'redis'
          ? {
            host: process.env['REDIS_HOST'] ?? '127.0.0.1',
            port: Number(process.env['REDIS_PORT'] ?? '6379'),
            password: process.env['REDIS_PASSWORD'],
            db: 0,
            tls: false,
            keyPrefix: 'oneunit:registry:',
          }
          : undefined,
        ttlMs: 30000,
        heartbeatIntervalMs: 10000,
      },
      auth: {
        type: 'allowlist',
        defaultPolicy: 'deny',
        entries: [
          // The external client service that is allowed to call order-service.
          {
            serviceId: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
            allowedOperations: ['order-service.createOrder', 'order-service.getOrder'],
            allowedTargets: ['order-service'],
          },
          // The service itself, so local handler invocations through the
          // secured dispatcher are not denied by the default-deny policy.
          {
            serviceId: process.env['SERVICE_ID'] ?? 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
            allowedOperations: ['order-service.createOrder', 'order-service.getOrder'],
            allowedTargets: ['order-service'],
          },
        ],
      },
      observability: {
        logging: true,
        metrics: true,
        tracing: true,
        audit: true,
        logLevel: 'info',
      },
      crypto: {
        rootKey,
        algorithm: 'aes-256-gcm',
        keyDerivation: 'hkdf-sha256',
      },
      adapters: {
        kafka: { enabled: false },
        nats: { enabled: false },
        tcp: { enabled: false },
        udp: { enabled: false },
        trpc: { enabled: false },
        grpc: { enabled: false },
        connect: { enabled: false },
      },
    },
  });

  // Register a secured RPC handler for the createOrder procedure. The
  // MicroserviceServer is a local method registry; the actual network
  // listener belongs to the gRPC adapter, which is configured separately.
  const server = createServer({
    service: app.identity,
    authorization: app.authorization,
    authenticationEnabled: true,
    audit: app.audit,
  });

  server.registerMethod('order-service', 'createOrder', async (input: OrderInput) => {
    if (!input?.customerId || !Array.isArray(input.items) || input.items.length === 0) {
      throw new Error('customerId and non-empty items are required');
    }
    const total = input.items.reduce((sum, item) => sum + item.quantity, 0);
    return { orderId: crypto.randomUUID(), status: 'accepted', total } satisfies OrderOutput;
  });

  server.registerMethod('order-service', 'getOrder', async (orderId: string) => {
    if (typeof orderId !== 'string' || orderId.length === 0) {
      throw new Error('orderId is required');
    }
    return { orderId, status: 'accepted', total: 0 };
  });

  // Verify the service is discoverable in the registry before accepting
  // traffic. This is the production-ready equivalent of a readiness probe.
  await app.start();
  const discovered = await app.registry.discover({ serviceId: app.identity.serviceId });
  if (discovered.length === 0) {
    throw new Error('Service failed to register with the registry');
  }

  app.logger.info('order-service started', {
    serviceId: app.identity.serviceId,
    instanceId: app.identity.instanceId,
    discoveredInstances: discovered.length,
  });

  // Demonstrate the secured handler end-to-end through the local server.
  const result = await server.handle(
    'order-service',
    'createOrder',
    { customerId: 'cust-123', items: [{ sku: 'SKU-1', quantity: 2 }] },
    {
      serviceId: app.identity.serviceId,
      correlationId: crypto.randomUUID(),
      headers: {},
      metadata: new Map(),
    },
  );
  app.logger.info('createOrder handled', { result });

  // By default the example exits after demonstrating the happy path, so it
  // can be used in CI. Set RUN_AS_SERVICE=1 to keep it alive as a long-lived
  // process and rely on SIGTERM/SIGINT for shutdown.
  if (process.env['RUN_AS_SERVICE'] !== '1') {
    await app.stop();
    app.logger.info('order-service stopped (example complete)');
    process.exit(0);
  }

  // Graceful shutdown: stop the lease renewal, deregister, and stop the
  // lifecycle manager in reverse registration order.
  const shutdown = async (): Promise<void> => {
    app.logger.info('shutting down');
    await app.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Block until a signal triggers shutdown.
  await new Promise<void>(() => {
    /* never resolves; shutdown is driven by signal handlers */
  });
}

main().catch((error) => {
  console.error('order-service failed to start', error);
  process.exit(1);
});