import { describe, it, expect } from 'vitest';
import {
  TransportCapabilities,
  TransportHealth,
  TransportMetrics,
  Transport,
  RpcClient,
  RpcServer,
  RpcMethodHandler,
  RpcContext,
  MessagePublisher,
  MessageSubscriber,
  MessageHandler,
  MessageContext,
  PublishOptions,
  SubscribeOptions,
  StreamTransport,
  DuplexStream,
  DatagramTransport,
} from '../../src/core/capabilities.js';

describe('Core Capabilities Types', () => {
  describe('TransportCapabilities', () => {
    it('should accept valid capability object', () => {
      const caps: TransportCapabilities = {
        requestResponse: true,
        streaming: false,
        publishSubscribe: true,
        durableDelivery: false,
        orderedDelivery: true,
        bidirectional: false,
      };
      expect(caps.requestResponse).toBe(true);
      expect(caps.streaming).toBe(false);
      expect(caps.publishSubscribe).toBe(true);
      expect(caps.durableDelivery).toBe(false);
      expect(caps.orderedDelivery).toBe(true);
      expect(caps.bidirectional).toBe(false);
    });

    it('should allow all false capabilities', () => {
      const caps: TransportCapabilities = {
        requestResponse: false,
        streaming: false,
        publishSubscribe: false,
        durableDelivery: false,
        orderedDelivery: false,
        bidirectional: false,
      };
      expect(caps.requestResponse).toBe(false);
    });
  });

  describe('TransportHealth', () => {
    it('should accept healthy status with details', () => {
      const health: TransportHealth = {
        status: 'healthy',
        checkedAt: Date.now(),
        details: { connections: 5, latency: 10 },
      };
      expect(health.status).toBe('healthy');
      expect(health.checkedAt).toBeTypeOf('number');
      expect(health.details).toEqual({ connections: 5, latency: 10 });
    });

    it('should accept degraded status without details', () => {
      const health: TransportHealth = {
        status: 'degraded',
        checkedAt: Date.now(),
      };
      expect(health.status).toBe('degraded');
      expect(health.details).toBeUndefined();
    });

    it('should accept unhealthy status', () => {
      const health: TransportHealth = {
        status: 'unhealthy',
        checkedAt: Date.now(),
        details: { error: 'connection refused' },
      };
      expect(health.status).toBe('unhealthy');
    });
  });

  describe('TransportMetrics', () => {
    it('should accept valid metrics object', () => {
      const metrics: TransportMetrics = {
        messagesSent: 100,
        messagesReceived: 95,
        bytesSent: 10240,
        bytesReceived: 9728,
        errors: 2,
        latencyMs: { min: 1, max: 50, avg: 10, p50: 8, p95: 25, p99: 45 },
      };
      expect(metrics.messagesSent).toBe(100);
      expect(metrics.latencyMs.p99).toBe(45);
    });
  });

  describe('Transport interface', () => {
    it('should define required transport properties and methods', () => {
      // This is a compile-time type check - if it compiles, the interface is valid
      const mockTransport: Transport = {
        name: 'test',
        capabilities: {
          requestResponse: false,
          streaming: false,
          publishSubscribe: false,
          durableDelivery: false,
          orderedDelivery: false,
          bidirectional: false,
        },
        start: async () => {},
        close: async () => {},
        healthCheck: async () => ({ status: 'healthy', checkedAt: Date.now() }),
      };
      expect(mockTransport.name).toBe('test');
    });
  });

  describe('RpcClient interface', () => {
    it('should define call and stream methods', () => {
      const mockClient: RpcClient = {
        call: async <TInput, TOutput>(service: string, method: string, input: TInput): Promise<TOutput> => {
          return input as unknown as TOutput;
        },
        stream: async function* <TInput, TOutput>(service: string, method: string, input: TInput): AsyncIterable<TOutput> {
          yield input as unknown as TOutput;
        },
      };
      expect(typeof mockClient.call).toBe('function');
      expect(typeof mockClient.stream).toBe('function');
    });
  });

  describe('RpcServer interface', () => {
    it('should define registerMethod and unregisterMethod', () => {
      const mockServer: RpcServer = {
        registerMethod: (service: string, method: string, handler: RpcMethodHandler) => {},
        unregisterMethod: (service: string, method: string) => {},
      };
      expect(typeof mockServer.registerMethod).toBe('function');
      expect(typeof mockServer.unregisterMethod).toBe('function');
    });
  });

  describe('RpcMethodHandler type', () => {
    it('should accept handler with correct signature', () => {
      const handler: RpcMethodHandler = async (input, context) => {
        return { success: true, input, context };
      };
      expect(typeof handler).toBe('function');
    });
  });

  describe('RpcContext interface', () => {
    it('should define required context properties', () => {
      const context: RpcContext = {
        serviceId: 'service-1',
        correlationId: 'corr-123',
        headers: { 'x-custom': 'value' },
        metadata: new Map([['key', 'value']]),
      };
      expect(context.serviceId).toBe('service-1');
      expect(context.correlationId).toBe('corr-123');
      expect(context.metadata.get('key')).toBe('value');
    });
  });

  describe('MessagePublisher interface', () => {
    it('should define publish method', () => {
      const publisher: MessagePublisher = {
        publish: async (topic: string, message: unknown, options?: PublishOptions) => {},
      };
      expect(typeof publisher.publish).toBe('function');
    });
  });

  describe('MessageSubscriber interface', () => {
    it('should define subscribe and unsubscribe methods', () => {
      const subscriber: MessageSubscriber = {
        subscribe: async (topic: string, handler: MessageHandler, options?: SubscribeOptions) => {},
        unsubscribe: async (topic: string) => {},
      };
      expect(typeof subscriber.subscribe).toBe('function');
      expect(typeof subscriber.unsubscribe).toBe('function');
    });
  });

  describe('MessageHandler type', () => {
    it('should accept handler with correct signature', () => {
      const handler: MessageHandler = async (message, context) => {
        // Handle message
      };
      expect(typeof handler).toBe('function');
    });
  });

  describe('MessageContext interface', () => {
    it('should define required context properties', () => {
      const context: MessageContext = {
        topic: 'events.user.created',
        correlationId: 'corr-123',
        traceContext: { traceparent: '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01' },
        headers: { 'content-type': 'application/json' },
      };
      expect(context.topic).toBe('events.user.created');
      expect(context.correlationId).toBe('corr-123');
    });

    it('should allow minimal context with only required fields', () => {
      const context: MessageContext = {
        topic: 'events.test',
      };
      expect(context.topic).toBe('events.test');
      expect(context.correlationId).toBeUndefined();
    });
  });

  describe('PublishOptions interface', () => {
    it('should accept all optional fields', () => {
      const options: PublishOptions = {
        key: 'partition-key',
        headers: { 'x-custom': 'value' },
        priority: 10,
      };
      expect(options.key).toBe('partition-key');
      expect(options.priority).toBe(10);
    });

    it('should allow empty options', () => {
      const options: PublishOptions = {};
      expect(options.key).toBeUndefined();
    });
  });

  describe('SubscribeOptions interface', () => {
    it('should accept all optional fields', () => {
      const options: SubscribeOptions = {
        groupId: 'consumer-group-1',
        fromBeginning: true,
        autoAck: false,
      };
      expect(options.groupId).toBe('consumer-group-1');
      expect(options.fromBeginning).toBe(true);
      expect(options.autoAck).toBe(false);
    });
  });

  describe('StreamTransport interface', () => {
    it('should define openStream method', () => {
      const streamTransport: StreamTransport = {
        openStream: async (remote: string) => {
          return {
            write: async () => {},
            read: async () => null,
            close: async () => {},
          };
        },
      };
      expect(typeof streamTransport.openStream).toBe('function');
    });
  });

  describe('DuplexStream interface', () => {
    it('should define write, read, close methods', () => {
      const stream: DuplexStream = {
        write: async (data: Uint8Array) => {},
        read: async () => new Uint8Array(),
        close: async () => {},
      };
      expect(typeof stream.write).toBe('function');
      expect(typeof stream.read).toBe('function');
      expect(typeof stream.close).toBe('function');
    });
  });

  describe('DatagramTransport interface', () => {
    it('should define send and onMessage methods', () => {
      const datagram: DatagramTransport = {
        send: async (data: Uint8Array, target: string, port: number) => {},
        onMessage: (handler) => {},
      };
      expect(typeof datagram.send).toBe('function');
      expect(typeof datagram.onMessage).toBe('function');
    });
  });
});