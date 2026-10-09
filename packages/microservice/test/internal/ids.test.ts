import { describe, it, expect, vi } from 'vitest';
import {
  generateId,
  generateServiceId,
  generateInstanceId,
  generateMessageId,
  generateCorrelationId,
  generateTraceId,
  generateSpanId,
  generateLeaseId,
  generateKeyId,
  generateSessionId,
} from '../../src/internal/ids.js';

describe('generateId', () => {
  it('should return a UUID v4', () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('should produce unique values', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateId());
    }
    expect(ids.size).toBe(100);
  });
});

describe('generateServiceId', () => {
  it('should prefix with svc-', () => {
    expect(generateServiceId()).toMatch(/^svc-[0-9a-f]{8}$/i);
  });

  it('should produce unique values', () => {
    expect(generateServiceId()).not.toBe(generateServiceId());
  });
});

describe('generateInstanceId', () => {
  it('should prefix with inst-', () => {
    expect(generateInstanceId()).toMatch(/^inst-[0-9a-f]{8}$/i);
  });
});

describe('generateMessageId', () => {
  it('should prefix with msg-', () => {
    expect(generateMessageId()).toMatch(/^msg-/);
  });
});

describe('generateCorrelationId', () => {
  it('should prefix with corr-', () => {
    expect(generateCorrelationId()).toMatch(/^corr-/);
  });
});

describe('generateTraceId', () => {
  it('should return a raw UUID', () => {
    expect(generateTraceId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

describe('generateSpanId', () => {
  it('should be 16 hex chars', () => {
    expect(generateSpanId()).toMatch(/^[0-9a-f]{16}$/i);
  });
});

describe('generateLeaseId', () => {
  it('should prefix with lease-', () => {
    expect(generateLeaseId()).toMatch(/^lease-/);
  });
});

describe('generateKeyId', () => {
  it('should prefix with key- and be 12 hex chars', () => {
    expect(generateKeyId()).toMatch(/^key-[0-9a-f]{12}$/i);
  });
});

describe('generateSessionId', () => {
  it('should prefix with sess-', () => {
    expect(generateSessionId()).toMatch(/^sess-/);
  });
});