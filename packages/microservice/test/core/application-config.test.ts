import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMicroservice } from '../../src/core/application.js';

describe('createMicroservice configuration bootstrap (OPS-01)', () => {
  let dir: string;
  let originalCwd: string;
  let originalRootKey: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oneunit-bootstrap-'));
    originalCwd = process.cwd();
    originalRootKey = process.env['CRYPTO_ROOT_KEY'];
    delete process.env['CRYPTO_ROOT_KEY'];
    delete process.env['CONFIG_PATH'];
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    if (originalRootKey === undefined) {
      delete process.env['CRYPTO_ROOT_KEY'];
    } else {
      process.env['CRYPTO_ROOT_KEY'] = originalRootKey;
    }
  });

  it('should NOT create a config file in the working directory during construction', async () => {
    process.env['CRYPTO_ROOT_KEY'] = 'k'.repeat(32);
    const app = await createMicroservice({
      config: {
        service: { id: '123e4567-e89b-12d3-a456-426614174000', name: 'test-service' },
        security: {},
        registry: { backend: 'memory' },
        auth: { type: 'allowlist', entries: [], defaultPolicy: 'deny' },
        observability: {},
        crypto: { rootKey: 'k'.repeat(32) },
      },
    });

    expect(existsSync(join(dir, 'config.json'))).toBe(false);
    expect(app.config.service.name).toBe('test-service');
  });

  it('should NOT mutate process.env.CRYPTO_ROOT_KEY during construction', async () => {
    process.env['CRYPTO_ROOT_KEY'] = 'k'.repeat(32);
    const before = { ...process.env };
    await createMicroservice({
      config: {
        service: { id: '123e4567-e89b-12d3-a456-426614174000', name: 'test-service' },
        security: {},
        registry: { backend: 'memory' },
        auth: { type: 'allowlist', entries: [], defaultPolicy: 'deny' },
        observability: {},
        crypto: { rootKey: 'k'.repeat(32) },
      },
    });
    const after = { ...process.env };
    expect(before).toEqual(after);
  });

  it('should work with a read-only working directory when config is supplied programmatically', async () => {
    process.env['CRYPTO_ROOT_KEY'] = 'k'.repeat(32);
    // We cannot easily make CWD read-only in tests, but we verify that
    // no filesystem write is attempted by checking config.json is absent.
    const app = await createMicroservice({
      config: {
        service: { id: '123e4567-e89b-12d3-a456-426614174000', name: 'readonly-service' },
        security: {},
        registry: { backend: 'memory' },
        auth: { type: 'allowlist', entries: [], defaultPolicy: 'deny' },
        observability: {},
        crypto: { rootKey: 'k'.repeat(32) },
      },
    });
    expect(existsSync(join(dir, 'config.json'))).toBe(false);
    expect(app.config.service.name).toBe('readonly-service');
  });

  it('should reject missing crypto.rootKey with a clear error', async () => {
    await expect(
      createMicroservice({
        config: {
          service: { id: '123e4567-e89b-12d3-a456-426614174000', name: 'test-service' },
          security: {},
          registry: { backend: 'memory' },
          auth: { type: 'allowlist', entries: [], defaultPolicy: 'deny' },
          observability: {},
          crypto: { rootKey: '' },
        },
      }),
    ).rejects.toThrow(/crypto.rootKey/);
  });

  it('should reject short crypto.rootKey (< 32 chars) with a clear error', async () => {
    await expect(
      createMicroservice({
        config: {
          service: { id: '123e4567-e89b-12d3-a456-426614174000', name: 'test-service' },
          security: {},
          registry: { backend: 'memory' },
          auth: { type: 'allowlist', entries: [], defaultPolicy: 'deny' },
          observability: {},
          crypto: { rootKey: 'short' },
        },
      }),
    ).rejects.toThrow(/crypto.rootKey/);
  });

  it('should accept a valid rootKey >= 32 chars', async () => {
    process.env['CRYPTO_ROOT_KEY'] = 'k'.repeat(32);
    const app = await createMicroservice({
      config: {
        service: { id: '123e4567-e89b-12d3-a456-426614174000', name: 'valid-key-service' },
        security: {},
        registry: { backend: 'memory' },
        auth: { type: 'allowlist', entries: [], defaultPolicy: 'deny' },
        observability: {},
        crypto: { rootKey: 'k'.repeat(32) },
      },
    });
    expect(app.config.service.name).toBe('valid-key-service');
  });
});
