export interface MessageEnvelope<TPayload = unknown> {
  version: 1;
  messageId: string;
  type: string;
  schemaVersion: number;

  source: {
    serviceId: string;
    instanceId: string;
  };

  destination?: {
    serviceId: string;
  };

  timestamp: number;
  correlationId?: string;
  traceContext?: Record<string, string>;

  payload: TPayload;
}

export interface EncryptedEnvelope {
  version: 1;
  cipherSuite: 'aes-256-gcm' | 'chacha20-poly1305';
  keyId: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
  authenticatedMetadata: Uint8Array;
  signature?: Uint8Array;
}

export function createMessageEnvelope<TPayload>(
  type: string,
  payload: TPayload,
  source: { serviceId: string; instanceId: string },
  options?: {
    destination?: { serviceId: string };
    correlationId?: string;
    traceContext?: Record<string, string>;
    schemaVersion?: number;
  }
): MessageEnvelope<TPayload> {
  return {
    version: 1,
    messageId: crypto.randomUUID(),
    type,
    schemaVersion: options?.schemaVersion ?? 1,
    source,
    destination: options?.destination,
    timestamp: Date.now(),
    correlationId: options?.correlationId,
    traceContext: options?.traceContext,
    payload,
  };
}

export function validateMessageEnvelope(envelope: unknown): boolean {
  if (!envelope || typeof envelope !== 'object') return false;
  const e = envelope as Record<string, unknown>;
  const version = e['version'];
  const validVersion = typeof version === 'number' && version === 1;
  const validMessageId = typeof e['messageId'] === 'string';
  const validType = typeof e['type'] === 'string';
  const validSchemaVersion = typeof e['schemaVersion'] === 'number';
  const validSource = e['source'] && typeof e['source'] === 'object';
  const validServiceId = validSource && typeof (e['source'] as Record<string, unknown>)['serviceId'] === 'string';
  const validInstanceId = validSource && typeof (e['source'] as Record<string, unknown>)['instanceId'] === 'string';
  const validTimestamp = typeof e['timestamp'] === 'number';
  const hasPayload = 'payload' in e;
  
  const result = validVersion && validMessageId && validType && validSchemaVersion && validServiceId && validInstanceId && validTimestamp && hasPayload;
  return Boolean(result);
}