import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigFile, ensureConfigFile, loadConfig } from '../../src/config/loader.js';
import { MicroserviceConfigSchema } from '../../src/config/schema.js';

// `createConfigFile` now requires CRYPTO_ROOT_KEY to be set explicitly
// (>= 32 chars). It no longer generates a root key implicitly and never
// mutates process.env. The environment is restored after every test.
let dir: string;
let originalRootKey: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oneunit-config-file-'));
  originalRootKey = process.env['CRYPTO_ROOT_KEY'];
  delete process.env['CRYPTO_ROOT_KEY'];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalRootKey === undefined) {
    delete process.env['CRYPTO_ROOT_KEY'];
  } else {
    process.env['CRYPTO_ROOT_KEY'] = originalRootKey;
  }
});

describe('createConfigFile', () => {
  it('should throw when CRYPTO_ROOT_KEY is not set', () => {
    const path = join(dir, 'config.json');
    expect(() => createConfigFile(path)).toThrow(/CRYPTO_ROOT_KEY/);
  });

  it('should throw when CRYPTO_ROOT_KEY is shorter than 32 chars', () => {
    process.env['CRYPTO_ROOT_KEY'] = 'short';
    const path = join(dir, 'config.json');
    expect(() => createConfigFile(path)).toThrow(/CRYPTO_ROOT_KEY/);
  });

  it('should create a config file when CRYPTO_ROOT_KEY is set (>= 32 chars)', () => {
    process.env['CRYPTO_ROOT_KEY'] = 'k'.repeat(32);
    const path = join(dir, 'config.json');

    const result = createConfigFile(path);

    expect(result).toBe(path);
    expect(existsSync(path)).toBe(true);
  });

  it('should write a configuration that passes the schema validation', () => {
    process.env['CRYPTO_ROOT_KEY'] = 'k'.repeat(32);
    const path = join(dir, 'config.json');

    createConfigFile(path);

    const written = JSON.parse(readFileSync(path, 'utf8'));
    const parsed = MicroserviceConfigSchema.safeParse(written);
    expect(parsed.success).toBe(true);
  });

  it('should apply the given overrides to the generated file', () => {
    process.env['CRYPTO_ROOT_KEY'] = 'k'.repeat(32);
    const path = join(dir, 'config.json');

    createConfigFile(path, { service: { name: 'generated-service' } });

    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.service.name).toBe('generated-service');
  });

  it('should keep an existing config file untouched', () => {
    process.env['CRYPTO_ROOT_KEY'] = 'k'.repeat(32);
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ marker: 'original' }));

    createConfigFile(path);

    expect(JSON.parse(readFileSync(path, 'utf8')).marker).toBe('original');
  });

  it('should use the root key from the environment when one is set', () => {
    process.env['CRYPTO_ROOT_KEY'] = 'k'.repeat(32);
    const path = join(dir, 'config.json');

    createConfigFile(path);

    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.crypto.rootKey).toBe('k'.repeat(32));
  });

  it('should create the parent directory when it does not exist', () => {
    process.env['CRYPTO_ROOT_KEY'] = 'k'.repeat(32);
    const path = join(dir, 'nested', 'config.json');

    createConfigFile(path);

    expect(existsSync(path)).toBe(true);
  });

  it('should produce a file that can be loaded back', () => {
    process.env['CRYPTO_ROOT_KEY'] = 'k'.repeat(32);
    const path = join(dir, 'config.json');
    createConfigFile(path);

    const config = loadConfig(path);

    expect(config.service.name).toBeTypeOf('string');
  });

  it('should set restrictive file permissions (0o600) on supported platforms', () => {
    process.env['CRYPTO_ROOT_KEY'] = 'k'.repeat(32);
    const path = join(dir, 'config.json');

    createConfigFile(path);

    const stat = statSync(path);
    const mode = stat.mode & 0o777;
    // Owner read+write only: 0o600
    expect(mode).toBe(0o600);
  });
});

describe('ensureConfigFile', () => {
  it('should behave like createConfigFile', () => {
    process.env['CRYPTO_ROOT_KEY'] = 'k'.repeat(32);
    const path = join(dir, 'config.json');

    const result = ensureConfigFile(path);

    expect(result).toBe(path);
    expect(existsSync(path)).toBe(true);
  });
});
