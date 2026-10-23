import { describe, it, expect } from 'vitest';
import {
  TransportCapabilities,
  TransportHealth,
  TransportMetrics,
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

});