import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CredentialProvider,
  CredentialStore,
  MemoryCredentialStore,
  FileCredentialStore,
  createCredentialProvider,
  ServiceCredentials,
} from '../../src/identity/credentials.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';

describe('ServiceCredentials', () => {
  it('should define the correct structure for x509', () => {
    const creds: ServiceCredentials = {
      type: 'x509',
      certificate: 'cert-data',
      privateKey: 'key-data',
      caCert: 'ca-data',
      issuedAt: Date.now(),
      issuer: 'test-issuer',
    };

    expect(creds.type).toBe('x509');
    expect(creds.certificate).toBe('cert-data');
    expect(creds.privateKey).toBe('key-data');
    expect(creds.caCert).toBe('ca-data');
  });

  it('should define the correct structure for jwt', () => {
    const creds: ServiceCredentials = {
      type: 'jwt',
      jwtSecret: 'jwt-secret',
      issuedAt: Date.now(),
    };

    expect(creds.type).toBe('jwt');
    expect(creds.jwtSecret).toBe('jwt-secret');
  });

  it('should define the correct structure for api-key', () => {
    const creds: ServiceCredentials = {
      type: 'api-key',
      apiKey: 'api-key-data',
      issuedAt: Date.now(),
    };

    expect(creds.type).toBe('api-key');
    expect(creds.apiKey).toBe('api-key-data');
  });

  it('should define the correct structure for mtls', () => {
    const creds: ServiceCredentials = {
      type: 'mtls',
      certificate: 'cert-data',
      privateKey: 'key-data',
      issuedAt: Date.now(),
    };

    expect(creds.type).toBe('mtls');
  });
});

describe('MemoryCredentialStore', () => {
  let store: MemoryCredentialStore;
  const testCredentials: ServiceCredentials = {
    type: 'x509',
    certificate: 'cert-data',
    privateKey: 'key-data',
    issuedAt: Date.now(),
  };

  beforeEach(() => {
    store = new MemoryCredentialStore();
  });

  it('should store and retrieve credentials', async () => {
    await store.store('service-1', testCredentials);
    const retrieved = await store.retrieve('service-1');

    expect(retrieved).toEqual(testCredentials);
  });

  it('should return null for non-existent service', async () => {
    const retrieved = await store.retrieve('non-existent');
    expect(retrieved).toBeNull();
  });

  it('should delete credentials', async () => {
    await store.store('service-1', testCredentials);
    await store.delete('service-1');
    const retrieved = await store.retrieve('service-1');

    expect(retrieved).toBeNull();
  });

  it('should list all stored service IDs', async () => {
    await store.store('service-1', testCredentials);
    await store.store('service-2', { ...testCredentials, type: 'jwt', jwtSecret: 'secret' });
    await store.store('service-3', { ...testCredentials, type: 'api-key', apiKey: 'key' });

    const list = await store.list();

    expect(list).toHaveLength(3);
    expect(list).toContain('service-1');
    expect(list).toContain('service-2');
    expect(list).toContain('service-3');
  });

  it('should return empty list when no credentials stored', async () => {
    const list = await store.list();
    expect(list).toEqual([]);
  });

  it('should overwrite existing credentials', async () => {
    const creds1: ServiceCredentials = { type: 'x509', certificate: 'cert1', issuedAt: 1 };
    const creds2: ServiceCredentials = { type: 'x509', certificate: 'cert2', issuedAt: 2 };

    await store.store('service-1', creds1);
    await store.store('service-1', creds2);

    const retrieved = await store.retrieve('service-1');
    expect(retrieved).toEqual(creds2);
  });
});

describe('FileCredentialStore', () => {
  let testDir: string;
  let store: FileCredentialStore;
  const testCredentials: ServiceCredentials = {
    type: 'x509',
    certificate: 'cert-data',
    privateKey: 'key-data',
    issuedAt: Date.now(),
  };

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `credential-store-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    store = new FileCredentialStore(testDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should store and retrieve credentials from file', async () => {
    await store.store('service-1', testCredentials);
    const retrieved = await store.retrieve('service-1');

    expect(retrieved).toEqual(testCredentials);
  });

  it('should return null for non-existent file', async () => {
    const retrieved = await store.retrieve('non-existent');
    expect(retrieved).toBeNull();
  });

  it('should delete credential file', async () => {
    await store.store('service-1', testCredentials);
    await store.delete('service-1');
    const retrieved = await store.retrieve('service-1');

    expect(retrieved).toBeNull();
  });

  it('should list all credential files', async () => {
    await store.store('service-1', testCredentials);
    await store.store('service-2', { ...testCredentials, type: 'jwt', jwtSecret: 'secret' });

    const list = await store.list();

    expect(list).toHaveLength(2);
    expect(list).toContain('service-1');
    expect(list).toContain('service-2');
  });

  it('should ignore non-JSON files', async () => {
    await store.store('service-1', testCredentials);
    await fs.writeFile(path.join(testDir, 'readme.txt'), 'not a credential file');

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list).toContain('service-1');
  });

  it('should handle missing directory gracefully', async () => {
    const nonExistentDir = path.join(tmpdir(), `non-existent-${Date.now()}`);
    const emptyStore = new FileCredentialStore(nonExistentDir);

    const list = await emptyStore.list();
    expect(list).toEqual([]);
  });
});

describe('createCredentialProvider', () => {
  const testCredentials: ServiceCredentials = {
    type: 'x509',
    certificate: 'cert-data',
    privateKey: 'key-data',
    issuedAt: Date.now(),
  };

  it('should create memory credential provider', async () => {
    const provider = await createCredentialProvider('memory');

    expect(provider).toBeDefined();
    expect(typeof provider.getCredentials).toBe('function');
    expect(typeof provider.rotateCredentials).toBe('function');
    expect(typeof provider.revokeCredentials).toBe('function');
  });

  it('should create file credential provider with path', async () => {
    const testDir = path.join(tmpdir(), `cred-provider-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    const provider = await createCredentialProvider('file', { path: testDir });

    expect(provider).toBeDefined();

    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should throw for file provider without path', async () => {
    await expect(createCredentialProvider('file', {})).rejects.toThrow(
      'File credential store requires a path'
    );
  });
});

describe('CredentialProvider operations', () => {
  const testCredentials: ServiceCredentials = {
    type: 'x509',
    certificate: 'cert-data',
    privateKey: 'key-data',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 86400000, // 24 hours
  };

  it('should create provider and test basic operations', async () => {
    const provider = await createCredentialProvider('memory');

    expect(provider).toBeDefined();
    expect(typeof provider.getCredentials).toBe('function');
    expect(typeof provider.rotateCredentials).toBe('function');
    expect(typeof provider.revokeCredentials).toBe('function');
  });

  it('should return null for non-existent credentials', async () => {
    const provider = await createCredentialProvider('memory');
    const creds = await provider.getCredentials('non-existent');
    expect(creds).toBeNull();
  });

  it('should revoke credentials without error', async () => {
    const provider = await createCredentialProvider('memory');
    await provider.revokeCredentials('service-1'); // Should not throw
    const creds = await provider.getCredentials('service-1');
    expect(creds).toBeNull();
  });

  it('should throw when rotating non-existent credentials', async () => {
    const provider = await createCredentialProvider('memory');
    
    await expect(provider.rotateCredentials('non-existent')).rejects.toThrow(
      'No credentials found for service: non-existent'
    );
  });

  it('should store and retrieve using MemoryCredentialStore directly', async () => {
    const { MemoryCredentialStore } = await import('../../src/identity/credentials.js');
    const store = new MemoryCredentialStore();
    
    await store.store('service-1', testCredentials);
    const retrieved = await store.retrieve('service-1');
    
    expect(retrieved).toEqual(testCredentials);
  });

  it('should rotate credentials using MemoryCredentialStore directly', async () => {
    const { MemoryCredentialStore } = await import('../../src/identity/credentials.js');
    const store = new MemoryCredentialStore();
    
    await store.store('service-1', testCredentials);
    
    // Simulate rotation
    const old = await store.retrieve('service-1');
    const rotated: ServiceCredentials = {
      ...old!,
      issuedAt: Date.now(),
      expiresAt: old!.expiresAt ? Date.now() + (old!.expiresAt - old!.issuedAt) : undefined,
    };
    
    await store.store('service-1', rotated);
    const retrieved = await store.retrieve('service-1');
    
    expect(retrieved.issuedAt).not.toBe(testCredentials.issuedAt);
    expect(retrieved.expiresAt).not.toBe(testCredentials.expiresAt);
  });
});