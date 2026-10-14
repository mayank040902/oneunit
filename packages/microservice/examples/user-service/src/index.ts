// User Service - Fastify server with @oneunit/microservice
import { createMicroservice } from '@oneunit/microservice';
import { createGrpcTransport } from '@oneunit/microservice/adapters/rpc/grpc';
import { createNatsTransport } from '@oneunit/microservice/adapters/messaging/nats';
import Fastify from 'fastify';
import { z } from 'zod';

// In-memory user store (with Redis cache fallback)
const users = new Map<string, { id: string; email: string; name: string; createdAt: string }>();

const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1),
  createdAt: z.string().datetime()
});

async function start() {
  console.log('🚀 Starting User Service...');

  // Create microservice app with Kafka and Redis
  const microservice = await createMicroservice({
    configPath: './config.json',
  });

  // Get Kafka messaging for event publishing
  const kafka = microservice.kafka;
  if (!kafka) {
    console.warn('⚠️  Kafka not initialized - events will not be published');
  }

  // Get Redis from registry (if using Redis backend)
  const registry = microservice.registry;

  // Register gRPC transport
  const grpcConfig = microservice.config.adapters?.grpc;
  if (grpcConfig?.enabled) {
    const { createGrpcTransport } = await import('@oneunit/microservice/adapters/rpc/grpc');
    const grpcTransport = createGrpcTransport({
      endpoint: grpcConfig.endpoint,
      protoPath: grpcConfig.protoPath,
      packageName: grpcConfig.packageName,
    });
    microservice.registerTransport(grpcTransport);
  }

  // Register NATS transport
  const natsConfig = microservice.config.adapters?.nats;
  let natsTransport: any = null;
  if (natsConfig?.enabled) {
    const { createNatsTransport } = await import('@oneunit/microservice/adapters/messaging/nats');
    natsTransport = createNatsTransport({
      servers: natsConfig.servers,
      clientName: natsConfig.clientName,
      maxReconnectAttempts: natsConfig.maxReconnectAttempts,
      reconnectTimeWait: natsConfig.reconnectTimeWait,
      subjects: natsConfig.subjects,
      jetstream: natsConfig.jetstream,
      auth: natsConfig.auth,
      tls: natsConfig.tls,
    });
    microservice.registerTransport(natsTransport);
  }

  // Create Fastify server
  const app = Fastify({ logger: false });

  // Health endpoint
  app.get('/health', async () => ({
    status: 'ok',
    service: 'user-service',
    kafka: kafka ? 'connected' : 'disconnected',
    nats: natsTransport ? 'connected' : 'disconnected',
    registry: 'redis'
  }));

  // Get all users
  app.get('/users', async () => {
    return Array.from(users.values());
  });

  // Get user by ID
  app.get('/users/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = users.get(id);
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }
    return user;
  });

  // Create user
  app.post('/users', async (request, reply) => {
    const body = request.body as { email: string; name: string };
    const user = {
      id: crypto.randomUUID(),
      email: body.email,
      name: body.name,
      createdAt: new Date().toISOString()
    };
    users.set(user.id, user);

    // Publish user.created event to Kafka and NATS
    const event = {
      eventId: crypto.randomUUID(),
      eventType: 'user.created',
      userId: user.id,
      payload: user,
      timestamp: new Date().toISOString()
    };
    
    if (kafka) {
      try {
        await kafka.publish('user.events', event, { key: user.id });
        console.log(`📤 [Kafka] Published user.created event for ${user.id}`);
      } catch (err) {
        console.error('Failed to publish Kafka event:', err);
      }
    }

    if (natsTransport) {
      try {
        await natsTransport.publish('user.events', event, { key: user.id });
        console.log(`📤 [NATS] Published user.created event for ${user.id}`);
      } catch (err) {
        console.error('Failed to publish NATS event:', err);
      }
    }

    return reply.status(201).send(user);
  });

  // Register RPC handler for other services to call
  const grpcTransport = microservice.getTransport('grpc');
  if (grpcTransport) {
    grpcTransport.registerMethod('UserService', 'GetUser', async (input: { id: string }) => {
      const user = users.get(input.id);
      if (!user) throw new Error('User not found');
      return user;
    });

    grpcTransport.registerMethod('UserService', 'CreateUser', async (input: { email: string; name: string }) => {
      const user = {
        id: crypto.randomUUID(),
        email: input.email,
        name: input.name,
        createdAt: new Date().toISOString()
      };
      users.set(user.id, user);

      // Also publish event
      const event = {
        eventId: crypto.randomUUID(),
        eventType: 'user.created',
        userId: user.id,
        payload: user,
        timestamp: new Date().toISOString()
      };
      if (kafka) {
        try {
          await kafka.publish('user.events', event, { key: user.id });
          console.log(`📤 [Kafka] Published user.created event for ${user.id}`);
        } catch (err) {
          console.error('Failed to publish Kafka event:', err);
        }
      }
      if (natsTransport) {
        try {
          await natsTransport.publish('user.events', event, { key: user.id });
          console.log(`📤 [NATS] Published user.created event for ${user.id}`);
        } catch (err) {
          console.error('Failed to publish NATS event:', err);
        }
      }
      return user;
    });
  }

  // Start microservice (registers service in Redis, starts transports)
  await microservice.start();

  // Subscribe to order events from Kafka
  if (kafka) {
    try {
      await kafka.subscribe('order.events', async (message, context) => {
        const event = message as any;
        console.log(`📥 [Kafka] Received order event: ${event.eventType} for order ${event.payload?.id}`);
        // Handle order events (e.g., notify user, update stats)
      }, { groupId: 'user-service-order-events' });
      console.log('📥 Subscribed to order.events (Kafka)');
    } catch (err) {
      console.error('Failed to subscribe to order.events (Kafka):', err);
    }
  }

  // Subscribe to order events from NATS
  if (natsTransport) {
    try {
      await natsTransport.subscribe('order.events', async (message, context) => {
        const event = message as any;
        console.log(`📥 [NATS] Received order event: ${event.eventType} for order ${event.payload?.id}`);
        // Handle order events (e.g., notify user, update stats)
      }, { groupId: 'user-service-order-events' });
      console.log('📥 Subscribed to order.events (NATS)');
    } catch (err) {
      console.error('Failed to subscribe to order.events (NATS):', err);
    }
  }

  // Start HTTP server
  const port = 3002;
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`✅ User Service running on http://localhost:${port}`);
  console.log(`   Health: http://localhost:${port}/health`);
  console.log(`   Users API: http://localhost:${port}/users`);
  console.log(`   Kafka: ${kafka ? 'enabled' : 'disabled'}`);
  console.log(`   NATS: ${natsTransport ? 'enabled' : 'disabled'}`);
  console.log(`   Registry: Redis`);
}

start().catch(console.error);