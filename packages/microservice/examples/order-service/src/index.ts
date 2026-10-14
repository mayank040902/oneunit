// Order Service - Fastify server with @oneunit/microservice
import { createMicroservice } from '@oneunit/microservice';
import { createGrpcTransport } from '@oneunit/microservice/adapters/rpc/grpc';
import { createNatsTransport } from '@oneunit/microservice/adapters/messaging/nats';
import Fastify from 'fastify';
import { z } from 'zod';

// In-memory order store
const orders = new Map<string, { 
  id: string; 
  userId: string; 
  items: Array<{ productId: string; quantity: number; price: number }>; 
  totalAmount: number; 
  status: string; 
  createdAt: string 
}>();

async function start() {
  console.log('🚀 Starting Order Service...');

  // Create microservice app with Kafka and Redis
  const microservice = await createMicroservice({
    configPath: './config.json',
  });

  // Get Kafka messaging for event publishing
  const kafka = microservice.kafka;
  if (!kafka) {
    console.warn('⚠️  Kafka not initialized - events will not be published');
  }

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
    service: 'order-service',
    kafka: kafka ? 'connected' : 'disconnected',
    nats: natsTransport ? 'connected' : 'disconnected',
    registry: 'redis'
  }));

  // Create a separate gRPC transport for calling User Service (client-only, no server)
  const userServiceGrpcTransport = createGrpcTransport({
    endpoint: 'localhost:50051',
    protoPath: './user.proto',
    packageName: 'user',
  });
  // Note: Don't call start() on client-only transport

  // Get all orders
  app.get('/orders', async () => {
    return Array.from(orders.values());
  });

  // Get order by ID
  app.get('/orders/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const order = orders.get(id);
    if (!order) {
      return reply.status(404).send({ error: 'Order not found' });
    }
    return order;
  });

  // Create order - validates user via gRPC call to User Service
  app.post('/orders', async (request, reply) => {
    const body = request.body as { 
      userId: string; 
      items: Array<{ productId: string; quantity: number; price: number }> 
    };
    
    // Validate user exists via gRPC
    try {
      const user = await userServiceGrpcTransport.call('UserService', 'GetUser', { id: body.userId });
      console.log(`✅ User validated via gRPC: ${user.name} (${user.email})`);
    } catch (error) {
      return reply.status(400).send({ 
        error: 'Invalid user ID', 
        details: error instanceof Error ? error.message : 'Unknown error' 
      });
    }

    const totalAmount = body.items.reduce((sum, item) => sum + item.quantity * item.price, 0);
    const order = {
      id: crypto.randomUUID(),
      userId: body.userId,
      items: body.items,
      totalAmount,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    orders.set(order.id, order);

    // Publish order.created event to Kafka and NATS
    const event = {
      eventId: crypto.randomUUID(),
      eventType: 'order.created',
      orderId: order.id,
      userId: order.userId,
      payload: order,
      timestamp: new Date().toISOString()
    };
    
    if (kafka) {
      try {
        await kafka.publish('order.events', event, { key: order.id });
        console.log(`📤 [Kafka] Published order.created event for ${order.id}`);
      } catch (err) {
        console.error('Failed to publish Kafka event:', err);
      }
    }

    if (natsTransport) {
      try {
        await natsTransport.publish('order.events', event, { key: order.id });
        console.log(`📤 [NATS] Published order.created event for ${order.id}`);
      } catch (err) {
        console.error('Failed to publish NATS event:', err);
      }
    }

    return reply.status(201).send(order);
  });

  // Register RPC handler
  const grpcTransport = microservice.getTransport('grpc');
  if (grpcTransport) {
    grpcTransport.registerMethod('OrderService', 'CreateOrder', async (input: { 
      userId: string; 
      items: Array<{ productId: string; quantity: number; price: number }> 
    }) => {
      const totalAmount = input.items.reduce((sum, item) => sum + item.quantity * item.price, 0);
      const order = {
        id: crypto.randomUUID(),
        userId: input.userId,
        items: input.items,
        totalAmount,
        status: 'pending',
        createdAt: new Date().toISOString()
      };
      orders.set(order.id, order);
      
      // Also publish event
      const event = {
        eventId: crypto.randomUUID(),
        eventType: 'order.created',
        orderId: order.id,
        userId: order.userId,
        payload: order,
        timestamp: new Date().toISOString()
      };
      if (kafka) {
        try {
          await kafka.publish('order.events', event, { key: order.id });
          console.log(`📤 [Kafka] Published order.created event for ${order.id}`);
        } catch (err) {
          console.error('Failed to publish Kafka event:', err);
        }
      }
      if (natsTransport) {
        try {
          await natsTransport.publish('order.events', event, { key: order.id });
          console.log(`📤 [NATS] Published order.created event for ${order.id}`);
        } catch (err) {
          console.error('Failed to publish NATS event:', err);
        }
      }
      return order;
    });
  }

  // Start microservice (registers service in Redis, starts transports)
  await microservice.start();

  // Subscribe to user events from Kafka
  if (kafka) {
    try {
      await kafka.subscribe('user.events', async (message, context) => {
        const event = message as any;
        console.log(`📥 [Kafka] Received user event: ${event.eventType} for user ${event.payload?.id}`);
        // Handle user events (e.g., invalidate cache, update user reference)
      }, { groupId: 'order-service-user-events' });
      console.log('📥 Subscribed to user.events (Kafka)');
    } catch (err) {
      console.error('Failed to subscribe to user.events (Kafka):', err);
    }
  }

  // Subscribe to user events from NATS
  if (natsTransport) {
    try {
      await natsTransport.subscribe('user.events', async (message, context) => {
        const event = message as any;
        console.log(`📥 [NATS] Received user event: ${event.eventType} for user ${event.payload?.id}`);
        // Handle user events (e.g., invalidate cache, update user reference)
      }, { groupId: 'order-service-user-events' });
      console.log('📥 Subscribed to user.events (NATS)');
    } catch (err) {
      console.error('Failed to subscribe to user.events (NATS):', err);
    }
  }

  // Cleanup gRPC transport on stop
  microservice.lifecycle.setHooks({
    onStop: async () => {
      await userServiceGrpcTransport.close();
    },
  });

  // Start HTTP server
  const port = 3001;
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`✅ Order Service running on http://localhost:${port}`);
  console.log(`   Health: http://localhost:${port}/health`);
  console.log(`   Orders API: http://localhost:${port}/orders`);
  console.log(`   Kafka: ${kafka ? 'enabled' : 'disabled'}`);
  console.log(`   NATS: ${natsTransport ? 'enabled' : 'disabled'}`);
  console.log(`   Registry: Redis`);
}

start().catch(console.error);