import { describe, it, expect } from 'vitest';
import { MicroserviceConfigSchema } from '../../src/config/schema.js';

describe('Config - Adversarial Validation', () => {
  it('should reject null config', () => {
    const result = MicroserviceConfigSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it('should reject empty object', () => {
    const result = MicroserviceConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('should reject invalid service id', () => {
    const result = MicroserviceConfigSchema.safeParse({
      service: { id: 'not-a-uuid', name: 'test', instanceId: '123e4567-e89b-12d3-a456-426614174000' },
      security: {}, registry: {}, auth: {}, observability: {}, crypto: { rootKey: 'a'.repeat(32) }
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty service name', () => {
    const result = MicroserviceConfigSchema.safeParse({
      service: { id: '123e4567-e89b-12d3-a456-426614174000', name: '', instanceId: '123e4567-e89b-12d3-a456-426614174000' },
      security: {}, registry: {}, auth: {}, observability: {}, crypto: { rootKey: 'a'.repeat(32) }
    });
    expect(result.success).toBe(false);
  });

  it('should reject short root key', () => {
    const result = MicroserviceConfigSchema.safeParse({
      service: { id: '123e4567-e89b-12d3-a456-426614174000', name: 'test', instanceId: '123e4567-e89b-12d3-a456-426614174000' },
      security: {}, registry: {}, auth: {}, observability: {}, crypto: { rootKey: 'short' }
    });
    expect(result.success).toBe(false);
  });
});
