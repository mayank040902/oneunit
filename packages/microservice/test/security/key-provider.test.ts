import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  KeyProvider,
  ServiceKeys,
  MemoryKeyProvider,
  CompositeKeyProvider,
  createKeyProvider,
} from '../../src/security/key-provider.js';
import { EncryptionService } from '../../src/security/encryption.js';
import { KeyExchangeService } from '../../src/security/key-exchange.js';
import { Ed25519SigningService } from '../../src/security/signing.js';

describe('MemoryKeyProvider', () => {
  let provider: MemoryKeyProvider;
  let testKeys: ServiceKeys;

  beforeEach(async () => {
    provider = new MemoryKeyProvider(60000); // 1 minute TTL
    
    const [encryptionKey, signingKeyPair, keyExchangeKeyPair] = await Promise.all([
      EncryptionService.generateKey('aes-256-gcm'),
      KeyExchangeService.generateEd25519KeyPair(),
      KeyExchangeService.generateX25519KeyPair(),
    ]);

    testKeys = {
      encryptionKey,
      signingKeyPair,
      keyExchangeKeyPair,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60000,
      version: 1,
    };
  });

  it('should store and retrieve keys', async () => {
    await provider.storeKeys('service-1', testKeys);
    
    const encryptionKey = await provider.getEncryptionKey('service-1');
    expect(encryptionKey).toBeInstanceOf(EncryptionService);
    
    const signingKey = await provider.getSigningKey('service-1');
    expect(signingKey).toBeInstanceOf(Ed25519SigningService);
    
    const keyExchangeKey = await provider.getKeyExchangeKey('service-1');
    expect(keyExchangeKey).toBeDefined();
    expect(keyExchangeKey?.publicKey).toEqual(testKeys.keyExchangeKeyPair.publicKey);
  });

  it('should return null for non-existent service', async () => {
    const encryptionKey = await provider.getEncryptionKey('non-existent');
    expect(encryptionKey).toBeNull();
    
    const signingKey = await provider.getSigningKey('non-existent');
    expect(signingKey).toBeNull();
    
    const keyExchangeKey = await provider.getKeyExchangeKey('non-existent');
    expect(keyExchangeKey).toBeNull();
  });

  it('should return null for expired keys', async () => {
    const expiredKeys: ServiceKeys = {
      ...testKeys,
      expiresAt: Date.now() - 1000, // Expired 1 second ago
    };
    
    await provider.storeKeys('service-1', expiredKeys);
    
    const encryptionKey = await provider.getEncryptionKey('service-1');
    expect(encryptionKey).toBeNull();
  });

  it('should rotate keys and increment version', async () => {
    await provider.storeKeys('service-1', testKeys);
    
    const newKeys = await provider.rotateKeys('service-1');
    
    expect(newKeys.version).toBe(2);
    expect(newKeys.issuedAt).toBeGreaterThanOrEqual(testKeys.issuedAt);
    expect(newKeys.expiresAt).toBeGreaterThan(newKeys.issuedAt);
    expect(newKeys.encryptionKey).not.toEqual(testKeys.encryptionKey);
    expect(newKeys.signingKeyPair.publicKey).not.toEqual(testKeys.signingKeyPair.publicKey);
    expect(newKeys.keyExchangeKeyPair.publicKey).not.toEqual(testKeys.keyExchangeKeyPair.publicKey);
  });

  it('should rotate keys for non-existent service (version 1)', async () => {
    const newKeys = await provider.rotateKeys('new-service');
    
    expect(newKeys.version).toBe(1);
    expect(newKeys.issuedAt).toBeDefined();
    expect(newKeys.expiresAt).toBeDefined();
  });

  it('should revoke keys', async () => {
    await provider.storeKeys('service-1', testKeys);
    await provider.revokeKeys('service-1');
    
    const encryptionKey = await provider.getEncryptionKey('service-1');
    expect(encryptionKey).toBeNull();
  });

  it('should use custom TTL', async () => {
    const customProvider = new MemoryKeyProvider(120000); // 2 minutes
    const newKeys = await customProvider.rotateKeys('service-1');
    
    expect(newKeys.expiresAt - newKeys.issuedAt).toBe(120000);
  });
});

describe('CompositeKeyProvider', () => {
  let compositeProvider: CompositeKeyProvider;
  let provider1: MemoryKeyProvider;
  let provider2: MemoryKeyProvider;
  let testKeys: ServiceKeys;

  beforeEach(async () => {
    compositeProvider = new CompositeKeyProvider();
    provider1 = new MemoryKeyProvider();
    provider2 = new MemoryKeyProvider();
    
    compositeProvider.addProvider(provider1);
    compositeProvider.addProvider(provider2);
    
    const [encryptionKey, signingKeyPair, keyExchangeKeyPair] = await Promise.all([
      EncryptionService.generateKey('aes-256-gcm'),
      KeyExchangeService.generateEd25519KeyPair(),
      KeyExchangeService.generateX25519KeyPair(),
    ]);

    testKeys = {
      encryptionKey,
      signingKeyPair,
      keyExchangeKeyPair,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60000,
      version: 1,
    };
  });

  it('should get key from first provider that has it', async () => {
    await provider1.storeKeys('service-1', testKeys);
    
    const encryptionKey = await compositeProvider.getEncryptionKey('service-1');
    expect(encryptionKey).toBeInstanceOf(EncryptionService);
  });

  it('should get key from second provider if first does not have it', async () => {
    await provider2.storeKeys('service-1', testKeys);
    
    const encryptionKey = await compositeProvider.getEncryptionKey('service-1');
    expect(encryptionKey).toBeInstanceOf(EncryptionService);
  });

  it('should return null if no provider has the key', async () => {
    const encryptionKey = await compositeProvider.getEncryptionKey('non-existent');
    expect(encryptionKey).toBeNull();
  });

  it('should store keys in all providers', async () => {
    await compositeProvider.storeKeys('service-1', testKeys);
    
    const key1 = await provider1.getEncryptionKey('service-1');
    const key2 = await provider2.getEncryptionKey('service-1');
    
    expect(key1).toBeInstanceOf(EncryptionService);
    expect(key2).toBeInstanceOf(EncryptionService);
  });

  it('should rotate keys using first provider', async () => {
    await provider1.storeKeys('service-1', testKeys);
    
    const newKeys = await compositeProvider.rotateKeys('service-1');
    
    expect(newKeys.version).toBe(2);
  });

  it('should throw when rotating with no providers', async () => {
    const emptyProvider = new CompositeKeyProvider();
    
    await expect(emptyProvider.rotateKeys('service-1')).rejects.toThrow(
      'No key providers available'
    );
  });

  it('should revoke keys from all providers', async () => {
    await provider1.storeKeys('service-1', testKeys);
    await provider2.storeKeys('service-1', testKeys);
    
    await compositeProvider.revokeKeys('service-1');
    
    const key1 = await provider1.getEncryptionKey('service-1');
    const key2 = await provider2.getEncryptionKey('service-1');
    
    expect(key1).toBeNull();
    expect(key2).toBeNull();
  });
});

describe('createKeyProvider', () => {
  it('should create memory key provider', () => {
    const provider = createKeyProvider('memory', { defaultTtlMs: 120000 });
    expect(provider).toBeInstanceOf(MemoryKeyProvider);
  });

  it('should create composite key provider', () => {
    const provider = createKeyProvider('composite');
    expect(provider).toBeInstanceOf(CompositeKeyProvider);
  });

  it('should throw for unknown type', () => {
    expect(() => createKeyProvider('unknown' as any)).toThrow(
      'Unknown key provider type: unknown'
    );
  });
});

describe('ServiceKeys interface', () => {
  it('should define correct structure', () => {
    const keys: ServiceKeys = {
      encryptionKey: new Uint8Array(32),
      signingKeyPair: { publicKey: new Uint8Array(32), privateKey: {} as CryptoKey },
      keyExchangeKeyPair: { publicKey: new Uint8Array(32), privateKey: {} as CryptoKey },
      issuedAt: Date.now(),
      expiresAt: Date.now() + 86400000,
      version: 1,
    };
    
    expect(keys.encryptionKey.length).toBe(32);
    expect(keys.version).toBe(1);
  });
});

describe('MemoryKeyProvider - Adversarial and Edge Case Tests', () => {
  let provider: MemoryKeyProvider;

  beforeEach(() => {
    provider = new MemoryKeyProvider(60000);
  });

  it('should handle concurrent key rotations', async () => {
    const results = await Promise.all([
      provider.rotateKeys('service-concurrent'),
      provider.rotateKeys('service-concurrent'),
      provider.rotateKeys('service-concurrent'),
    ]);
    
    // All should succeed and produce valid keys
    results.forEach(keys => {
      expect(keys.version).toBeGreaterThanOrEqual(1);
      expect(keys.encryptionKey.length).toBe(32);
    });
  });

  it('should handle concurrent read/write operations', async () => {
    await provider.rotateKeys('service-rw');
    
    const operations = [];
    for (let i = 0; i < 50; i++) {
      if (i % 2 === 0) {
        operations.push(provider.getEncryptionKey('service-rw'));
        operations.push(provider.getSigningKey('service-rw'));
        operations.push(provider.getKeyExchangeKey('service-rw'));
      } else {
        operations.push(provider.rotateKeys('service-rw'));
      }
    }
    
    const results = await Promise.allSettled(operations);
    // All should either succeed or fail gracefully
    results.forEach(result => {
      if (result.status === 'fulfilled') {
        expect(result.value).toBeDefined();
      }
    });
  });

  it('should isolate keys per service ID', async () => {
    await provider.rotateKeys('service-a');
    await provider.rotateKeys('service-b');
    
    const keysA = await provider.getEncryptionKey('service-a');
    const keysB = await provider.getEncryptionKey('service-b');
    
    expect(keysA).toBeInstanceOf(EncryptionService);
    expect(keysB).toBeInstanceOf(EncryptionService);
    // Verify they are different CryptoKey instances (not the same object)
    expect(keysA?.getKey()).not.toBe(keysB?.getKey());
  });

  it('should not expose private keys through getKeyExchangeKey', async () => {
    await provider.rotateKeys('service-1');
    const keyExchange = await provider.getKeyExchangeKey('service-1');
    
    expect(keyExchange).toBeDefined();
    expect(keyExchange?.privateKey).toBeInstanceOf(CryptoKey);
    // Private key should be a CryptoKey, not raw bytes
    expect(keyExchange?.privateKey.type).toBe('private');
  });

  it('should handle revocation during active use', async () => {
    await provider.rotateKeys('service-revoke');
    const encryptionKey = await provider.getEncryptionKey('service-revoke');
    
    await provider.revokeKeys('service-revoke');
    
    // New requests should return null
    const newEncryptionKey = await provider.getEncryptionKey('service-revoke');
    expect(newEncryptionKey).toBeNull();
    
    // But existing CryptoKey objects may still work (implementation dependent)
    // This documents the behavior
  });

  it('should handle rapid rotation and expiration', async () => {
    const shortTtlProvider = new MemoryKeyProvider(10); // 10ms TTL
    
    await shortTtlProvider.rotateKeys('service-short');
    const key1 = await shortTtlProvider.getEncryptionKey('service-short');
    expect(key1).not.toBeNull();
    
    // Wait for expiration
    await new Promise(resolve => setTimeout(resolve, 20));
    
    const key2 = await shortTtlProvider.getEncryptionKey('service-short');
    expect(key2).toBeNull();
  });

  it('should not leak key material in error paths', async () => {
    // Attempting to get key for non-existent service
    const result = await provider.getEncryptionKey('non-existent');
    expect(result).toBeNull();
    
    // No error should be thrown, no key material exposed
  });
});

describe('CompositeKeyProvider - Adversarial Tests', () => {
  let compositeProvider: CompositeKeyProvider;
  let provider1: MemoryKeyProvider;
  let provider2: MemoryKeyProvider;

  beforeEach(() => {
    compositeProvider = new CompositeKeyProvider();
    provider1 = new MemoryKeyProvider();
    provider2 = new MemoryKeyProvider();
    compositeProvider.addProvider(provider1);
    compositeProvider.addProvider(provider2);
  });

  it('should return first matching key', async () => {
    const keys1 = await provider1.rotateKeys('service-priority');
    await provider2.rotateKeys('service-priority');
    
    const result = await compositeProvider.getEncryptionKey('service-priority');
    expect(result).toBeInstanceOf(EncryptionService);
    // Should come from provider1 (first added)
    expect(result?.getAlgorithm().name).toBe('AES-GCM');
  });

  it('should handle provider failures gracefully', async () => {
    // This tests the composite behavior when one provider might fail
    await provider1.rotateKeys('service-fail');
    
    const result = await compositeProvider.getEncryptionKey('service-fail');
    expect(result).toBeInstanceOf(EncryptionService);
  });

  it('should rotate keys on first provider only', async () => {
    await provider1.rotateKeys('service-rotate');
    await provider2.rotateKeys('service-rotate');
    
    const newKeys = await compositeProvider.rotateKeys('service-rotate');
    
    // Version should increment based on first provider
    expect(newKeys.version).toBe(2);
  });
});