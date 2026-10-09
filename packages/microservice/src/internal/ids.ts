export function generateId(): string {
  return crypto.randomUUID();
}

export function generateServiceId(): string {
  return `svc-${crypto.randomUUID().slice(0, 8)}`;
}

export function generateInstanceId(): string {
  return `inst-${crypto.randomUUID().slice(0, 8)}`;
}

export function generateMessageId(): string {
  return `msg-${crypto.randomUUID()}`;
}

export function generateCorrelationId(): string {
  return `corr-${crypto.randomUUID()}`;
}

export function generateTraceId(): string {
  return crypto.randomUUID();
}

export function generateSpanId(): string {
  return crypto.randomUUID().slice(0, 16);
}

export function generateLeaseId(): string {
  return `lease-${crypto.randomUUID()}`;
}

export function generateKeyId(): string {
  return `key-${crypto.randomUUID().slice(0, 12)}`;
}

export function generateSessionId(): string {
  return `sess-${crypto.randomUUID()}`;
}