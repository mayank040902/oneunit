import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config/loader.js';

describe('Config Loader - Adversarial Tests', () => {
  it('should handle missing config path gracefully with env fallback', () => {
    const old = process.env.SERVICE_NAME;
    try {
      delete process.env.CONFIG_PATH;
      process.env.SERVICE_NAME = 'test-service';
      process.env.CRYPTO_ROOT_KEY = 'a'.repeat(32);
      process.env.SERVICE_ID = '123e4567-e89b-12d3-a456-426614174000';
      process.env.SERVICE_INSTANCE_ID = '123e4567-e89b-12d3-a456-426614174000';
      const cfg = loadConfig('/non/existent/file.json');
      expect(cfg.service.name).toBe('test-service');
    } finally {
      if (old) process.env.SERVICE_NAME = old;
      delete process.env.CRYPTO_ROOT_KEY;
      delete process.env.SERVICE_ID;
      delete process.env.SERVICE_INSTANCE_ID;
    }
  });

  it('should validate required fields when loading from env', () => {
    const oldName = process.env.SERVICE_NAME;
    const oldKey = process.env.CRYPTO_ROOT_KEY;
    try {
      delete process.env.CONFIG_PATH;
      delete process.env.SERVICE_NAME;
      delete process.env.CRYPTO_ROOT_KEY;
      expect(() => loadConfig('/non/existent/file.json')).toThrow();
    } finally {
      if (oldName) process.env.SERVICE_NAME = oldName;
      if (oldKey) process.env.CRYPTO_ROOT_KEY = oldKey;
    }
  });
});
