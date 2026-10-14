import { describe, it, expect } from 'vitest';
import { generateCorrelationId, generateTraceId, generateSpanId } from '../../src/internal/ids.js';

describe('IDs - Adversarial Tests', () => {
  it('should generate valid format IDs', () => {
    expect(generateCorrelationId()).toMatch(/^corr-/);
    expect(generateTraceId()).toMatch(/^[0-9a-f-]+$/);
    expect(generateSpanId()).toMatch(/^[0-9a-f]+$/);
  });

  it('should generate unique IDs', () => {
    const ids = new Set();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateCorrelationId());
    }
    expect(ids.size).toBe(1000);
  });

  it('should not include PII or sensitive data', () => {
    for (let i = 0; i < 100; i++) {
      const id = generateCorrelationId();
      expect(id.toLowerCase()).not.toMatch(/password|secret|token|key/);
    }
  });
});
