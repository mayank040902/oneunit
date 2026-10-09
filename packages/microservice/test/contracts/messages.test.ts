import { describe, it, expect } from 'vitest';
import {
  MessageEnvelope,
  EncryptedEnvelope,
  createMessageEnvelope,
  validateMessageEnvelope,
} from '../../src/contracts/messages.js';

describe('MessageEnvelope', () => {
  const validSource = { serviceId: '123e4567-e89b-12d3-a456-426614174000', instanceId: '123e4567-e89b-12d3-a456-426614174001' };

  it('should create a valid message envelope with all required fields', () => {
    const envelope = createMessageEnvelope('test.type', { data: 'hello' }, validSource);

    expect(envelope.version).toBe(1);
    expect(envelope.messageId).toBeDefined();
    expect(typeof envelope.messageId).toBe('string');
    expect(envelope.type).toBe('test.type');
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.source).toEqual(validSource);
    expect(envelope.timestamp).toBeDefined();
    expect(typeof envelope.timestamp).toBe('number');
    expect(envelope.payload).toEqual({ data: 'hello' });
    expect(envelope.destination).toBeUndefined();
    expect(envelope.correlationId).toBeUndefined();
    expect(envelope.traceContext).toBeUndefined();
  });

  it('should include optional fields when provided', () => {
    const options = {
      destination: { serviceId: 'target-service' },
      correlationId: 'corr-123',
      traceContext: { 'trace-id': 'trace-123' },
      schemaVersion: 2,
    };
    const envelope = createMessageEnvelope('test.type', { data: 'hello' }, validSource, options);

    expect(envelope.destination).toEqual({ serviceId: 'target-service' });
    expect(envelope.correlationId).toBe('corr-123');
    expect(envelope.traceContext).toEqual({ 'trace-id': 'trace-123' });
    expect(envelope.schemaVersion).toBe(2);
  });

  it('should generate unique message IDs', () => {
    const envelope1 = createMessageEnvelope('test.type', {}, validSource);
    const envelope2 = createMessageEnvelope('test.type', {}, validSource);

    expect(envelope1.messageId).not.toBe(envelope2.messageId);
  });

  it('should include payload as-is', () => {
    const payload = { complex: { nested: ['array', 123, true] } };
    const envelope = createMessageEnvelope('test.type', payload, validSource);

    expect(envelope.payload).toBe(payload);
  });
});

describe('validateMessageEnvelope', () => {
  const validSource = { serviceId: '123e4567-e89b-12d3-a456-426614174000', instanceId: '123e4567-e89b-12d3-a456-426614174001' };
  const validEnvelope = createMessageEnvelope('test.type', { data: 'hello' }, validSource);

  it('should return true for valid envelope', () => {
    expect(validateMessageEnvelope(validEnvelope)).toBe(true);
  });

  it('should return false for null', () => {
    expect(validateMessageEnvelope(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(validateMessageEnvelope(undefined)).toBe(false);
  });

  it('should return false for non-object', () => {
    expect(validateMessageEnvelope('string')).toBe(false);
    expect(validateMessageEnvelope(123)).toBe(false);
    expect(validateMessageEnvelope([])).toBe(false);
  });

  it('should return false for empty object', () => {
    expect(validateMessageEnvelope({})).toBe(false);
  });

  it('should return false when version is missing', () => {
    const { version, ...envelope } = validEnvelope;
    expect(validateMessageEnvelope(envelope)).toBe(false);
  });

  it('should return false when version is not 1', () => {
    const envelope = { ...validEnvelope, version: 2 };
    expect(validateMessageEnvelope(envelope)).toBe(false);
  });

  it('should return false when version is not a number', () => {
    const envelope = { ...validEnvelope, version: '1' };
    expect(validateMessageEnvelope(envelope)).toBe(false);
  });

  it('should return false when messageId is missing', () => {
    const { messageId, ...envelope } = validEnvelope;
    expect(validateMessageEnvelope(envelope)).toBe(false);
  });

  it('should return false when messageId is not a string', () => {
    const envelope = { ...validEnvelope, messageId: 123 };
    expect(validateMessageEnvelope(envelope)).toBe(false);
  });

  it('should return false when type is missing', () => {
    const { type, ...envelope } = validEnvelope;
    expect(validateMessageEnvelope(envelope)).toBe(false);
  });

  it('should return false when type is not a string', () => {
    const envelope = { ...validEnvelope, type: 123 };
    expect(validateMessageEnvelope(envelope)).toBe(false);
  });

  it('should return false when schemaVersion is missing', () => {
    const { schemaVersion, ...envelope } = validEnvelope;
    expect(validateMessageEnvelope(envelope)).toBe(false);
  });

  it('should return false when schemaVersion is not a number', () => {
    const envelope = { ...validEnvelope, schemaVersion: '1' };
    expect(validateMessageEnvelope(envelope)).toBe(false);
  });

  it('should return false when source is missing', () => {
    const { source, ...envelope } = validEnvelope;
    expect(validateMessageEnvelope(envelope)).toBe(false);
  });

  it('should return false when source is not an object', () => {
    const envelope = { ...validEnvelope, source: 'invalid' };
    expect(validateMessageEnvelope(envelope)).toBe(false);
  });

  it('should return false when source.serviceId is missing', () => {
    const envelope = { ...validEnvelope, source: { ...validSource, serviceId: undefined } };
    expect(validateMessageEnvelope(envelope)).toBe(false);
  });

  it('should return false when source.serviceId is not a string', () => {
    const envelope = { ...validEnvelope, source: { ...validSource, serviceId: 123 } };
    expect(validateMessageEnvelope(envelope)).toBe(false);
  });

  it('should return false when source.instanceId is missing', () => {
    const envelope = { ...validEnvelope, source: { ...validSource, instanceId: undefined } };
    expect(validateMessageEnvelope(envelope)).toBe(false);
  });

  it('should return false when source.instanceId is not a string', () => {
    const envelope = { ...validEnvelope, source: { ...validSource, instanceId: 123 } };
    expect(validateMessageEnvelope(envelope)).toBe(false);
  });

  it('should return false when timestamp is missing', () => {
    const { timestamp, ...envelope } = validEnvelope;
    expect(validateMessageEnvelope(envelope)).toBe(false);
  });

  it('should return false when timestamp is not a number', () => {
    const envelope = { ...validEnvelope, timestamp: 'now' };
    expect(validateMessageEnvelope(envelope)).toBe(false);
  });

  it('should return false when payload is missing', () => {
    const { payload, ...envelope } = validEnvelope;
    expect(validateMessageEnvelope(envelope)).toBe(false);
  });

  it('should return true when payload is null', () => {
    const envelope = { ...validEnvelope, payload: null };
    expect(validateMessageEnvelope(envelope)).toBe(true);
  });

  it('should return true when destination is provided', () => {
    const envelope = { ...validEnvelope, destination: { serviceId: 'target' } };
    expect(validateMessageEnvelope(envelope)).toBe(true);
  });

  it('should return true when correlationId is provided', () => {
    const envelope = { ...validEnvelope, correlationId: 'corr-123' };
    expect(validateMessageEnvelope(envelope)).toBe(true);
  });

  it('should return true when traceContext is provided', () => {
    const envelope = { ...validEnvelope, traceContext: { 'trace-id': '123' } };
    expect(validateMessageEnvelope(envelope)).toBe(true);
  });
});

describe('EncryptedEnvelope', () => {
  it('should define the correct structure', () => {
    const envelope: EncryptedEnvelope = {
      version: 1,
      cipherSuite: 'aes-256-gcm',
      keyId: 'key-123',
      nonce: new Uint8Array(12),
      ciphertext: new Uint8Array(32),
      tag: new Uint8Array(16),
      authenticatedMetadata: new Uint8Array(0),
      signature: new Uint8Array(64),
    };

    expect(envelope.version).toBe(1);
    expect(['aes-256-gcm', 'chacha20-poly1305']).toContain(envelope.cipherSuite);
    expect(envelope.keyId).toBe('key-123');
    expect(envelope.nonce).toBeInstanceOf(Uint8Array);
    expect(envelope.ciphertext).toBeInstanceOf(Uint8Array);
    expect(envelope.tag).toBeInstanceOf(Uint8Array);
    expect(envelope.authenticatedMetadata).toBeInstanceOf(Uint8Array);
    expect(envelope.signature).toBeInstanceOf(Uint8Array);
  });

  it('should allow optional signature', () => {
    const envelope: EncryptedEnvelope = {
      version: 1,
      cipherSuite: 'chacha20-poly1305',
      keyId: 'key-123',
      nonce: new Uint8Array(12),
      ciphertext: new Uint8Array(32),
      tag: new Uint8Array(16),
      authenticatedMetadata: new Uint8Array(0),
    };

    expect(envelope.signature).toBeUndefined();
  });
});