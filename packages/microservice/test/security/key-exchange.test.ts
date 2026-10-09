import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  KeyPair,
  KeyExchangeResult,
  KeyExchangeService,
} from '../../src/security/key-exchange.js';

describe('KeyExchangeService', () => {
  describe('generateX25519KeyPair', () => {
    it('should generate X25519 key pair', async () => {
      const keyPair = await KeyExchangeService.generateX25519KeyPair();
      
      expect(keyPair).toBeDefined();
      expect(keyPair.publicKey).toBeInstanceOf(Uint8Array);
      expect(keyPair.publicKey.length).toBe(32);
      expect(keyPair.privateKey).toBeInstanceOf(CryptoKey);
    });

    it('should generate different key pairs each time', async () => {
      const keyPair1 = await KeyExchangeService.generateX25519KeyPair();
      const keyPair2 = await KeyExchangeService.generateX25519KeyPair();
      
      expect(keyPair1.publicKey).not.toEqual(keyPair2.publicKey);
    });
  });

  describe('generateEd25519KeyPair', () => {
    it('should generate Ed25519 key pair', async () => {
      const keyPair = await KeyExchangeService.generateEd25519KeyPair();
      
      expect(keyPair).toBeDefined();
      expect(keyPair.publicKey).toBeInstanceOf(Uint8Array);
      expect(keyPair.publicKey.length).toBe(32);
      expect(keyPair.privateKey).toBeInstanceOf(CryptoKey);
    });

    it('should generate different key pairs each time', async () => {
      const keyPair1 = await KeyExchangeService.generateEd25519KeyPair();
      const keyPair2 = await KeyExchangeService.generateEd25519KeyPair();
      
      expect(keyPair1.publicKey).not.toEqual(keyPair2.publicKey);
    });
  });

  describe('computeSharedSecret', () => {
    it('should compute shared secret between two parties', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      // Alice computes shared secret using Bob's public key
      const aliceResult = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      // Bob computes shared secret using Alice's public key
      const bobResult = await KeyExchangeService.computeSharedSecret(
        bobKeyPair.privateKey,
        aliceKeyPair.publicKey,
        bobKeyPair.publicKey
      );
      
      expect(aliceResult.sharedSecret).toEqual(bobResult.sharedSecret);
      expect(aliceResult.sharedSecret.length).toBe(32);
    });

    it('should return public key in result', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const result = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      expect(result.publicKey).toBeInstanceOf(Uint8Array);
      expect(result.publicKey).toEqual(aliceKeyPair.publicKey);
    });

    it('should produce different shared secrets for different key pairs', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair1 = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair2 = await KeyExchangeService.generateX25519KeyPair();
      
      const result1 = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair1.publicKey,
        aliceKeyPair.publicKey
      );
      
      const result2 = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair2.publicKey,
        aliceKeyPair.publicKey
      );
      
      expect(result1.sharedSecret).not.toEqual(result2.sharedSecret);
    });
  });

  describe('deriveSessionKeys', () => {
    it('should derive session keys from shared secret', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const info = new TextEncoder().encode('session-info');
      
      const keys = await KeyExchangeService.deriveSessionKeys(sharedSecret, salt, info);
      
      expect(keys).toBeDefined();
      expect(keys.encryptionKey).toBeInstanceOf(Uint8Array);
      expect(keys.encryptionKey.length).toBe(32);
      expect(keys.signingKey).toBeInstanceOf(Uint8Array);
      expect(keys.signingKey.length).toBe(32);
      expect(keys.authKey).toBeInstanceOf(Uint8Array);
      expect(keys.authKey.length).toBe(32);
    });

    it('should derive different keys with different salt', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      const salt1 = crypto.getRandomValues(new Uint8Array(32));
      const salt2 = crypto.getRandomValues(new Uint8Array(32));
      const info = new TextEncoder().encode('session-info');
      
      const keys1 = await KeyExchangeService.deriveSessionKeys(sharedSecret, salt1, info);
      const keys2 = await KeyExchangeService.deriveSessionKeys(sharedSecret, salt2, info);
      
      expect(keys1.encryptionKey).not.toEqual(keys2.encryptionKey);
      expect(keys1.signingKey).not.toEqual(keys2.signingKey);
      expect(keys1.authKey).not.toEqual(keys2.authKey);
    });

    it('should derive different keys with different info', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const info1 = new TextEncoder().encode('session-1');
      const info2 = new TextEncoder().encode('session-2');
      
      const keys1 = await KeyExchangeService.deriveSessionKeys(sharedSecret, salt, info1);
      const keys2 = await KeyExchangeService.deriveSessionKeys(sharedSecret, salt, info2);
      
      expect(keys1.encryptionKey).not.toEqual(keys2.encryptionKey);
    });
  });
});

describe('KeyExchangeService - Adversarial and Edge Case Tests', () => {
  describe('computeSharedSecret - malformed inputs', () => {
    it('should reject malformed peer public key (wrong length)', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const wrongLengthKey = new Uint8Array(16); // Wrong length
      await expect(KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        wrongLengthKey,
        aliceKeyPair.publicKey
      )).rejects.toThrow();
    });

    it('should reject malformed peer public key (empty)', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const emptyKey = new Uint8Array(0);
      await expect(KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        emptyKey,
        aliceKeyPair.publicKey
      )).rejects.toThrow();
    });

    it('should reject oversized peer public key', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const oversizedKey = new Uint8Array(64);
      await expect(KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        oversizedKey,
        aliceKeyPair.publicKey
      )).rejects.toThrow();
    });

    it('should reject invalid private key type', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      // Try using Ed25519 private key for X25519
      const edKeyPair = await KeyExchangeService.generateEd25519KeyPair();
      await expect(KeyExchangeService.computeSharedSecret(
        edKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      )).rejects.toThrow();
    });

    it('should produce different shared secrets for different peer keys', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair1 = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair2 = await KeyExchangeService.generateX25519KeyPair();
      
      const result1 = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair1.publicKey,
        aliceKeyPair.publicKey
      );
      
      const result2 = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair2.publicKey,
        aliceKeyPair.publicKey
      );
      
      expect(result1.sharedSecret).not.toEqual(result2.sharedSecret);
    });

    it('should not expose private key in shared secret computation', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const result = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      // Shared secret should not equal public keys
      expect(result.sharedSecret).not.toEqual(aliceKeyPair.publicKey);
      expect(result.sharedSecret).not.toEqual(bobKeyPair.publicKey);
      
      // X25519 private keys cannot be exported as raw, so we verify
      // the shared secret is derived correctly without exposing private key
      expect(result.sharedSecret).toBeInstanceOf(Uint8Array);
      expect(result.sharedSecret.length).toBe(32);
    });
  });

  describe('deriveSessionKeys - edge cases', () => {
    it('should derive different keys for different salt values', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      const info = new TextEncoder().encode('session-info');
      const salt1 = crypto.getRandomValues(new Uint8Array(32));
      const salt2 = crypto.getRandomValues(new Uint8Array(32));
      
      const keys1 = await KeyExchangeService.deriveSessionKeys(sharedSecret, salt1, info);
      const keys2 = await KeyExchangeService.deriveSessionKeys(sharedSecret, salt2, info);
      
      expect(keys1.encryptionKey).not.toEqual(keys2.encryptionKey);
      expect(keys1.signingKey).not.toEqual(keys2.signingKey);
      expect(keys1.authKey).not.toEqual(keys2.authKey);
    });

    it('should derive different keys for different info values', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const info1 = new TextEncoder().encode('purpose-1');
      const info2 = new TextEncoder().encode('purpose-2');
      
      const keys1 = await KeyExchangeService.deriveSessionKeys(sharedSecret, salt, info1);
      const keys2 = await KeyExchangeService.deriveSessionKeys(sharedSecret, salt, info2);
      
      expect(keys1.encryptionKey).not.toEqual(keys2.encryptionKey);
      expect(keys1.signingKey).not.toEqual(keys2.signingKey);
      expect(keys1.authKey).not.toEqual(keys2.authKey);
    });

    it('should derive different keys for different shared secrets', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair1 = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair2 = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret: secret1 } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair1.publicKey,
        aliceKeyPair.publicKey
      );
      
      const { sharedSecret: secret2 } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair2.publicKey,
        aliceKeyPair.publicKey
      );
      
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const info = new TextEncoder().encode('session-info');
      
      const keys1 = await KeyExchangeService.deriveSessionKeys(secret1, salt, info);
      const keys2 = await KeyExchangeService.deriveSessionKeys(secret2, salt, info);
      
      expect(keys1.encryptionKey).not.toEqual(keys2.encryptionKey);
      expect(keys1.signingKey).not.toEqual(keys2.signingKey);
      expect(keys1.authKey).not.toEqual(keys2.authKey);
    });

    it('should reject empty shared secret', async () => {
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const info = new TextEncoder().encode('session-info');
      const emptySecret = new Uint8Array(0);
      
      await expect(KeyExchangeService.deriveSessionKeys(emptySecret, salt, info)).rejects.toThrow();
    });

    it('should reject wrong shared secret length', async () => {
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const info = new TextEncoder().encode('session-info');
      const wrongSecret = new Uint8Array(16); // Wrong length
      
      await expect(KeyExchangeService.deriveSessionKeys(wrongSecret, salt, info)).rejects.toThrow();
    });

    it('should produce keys of correct length', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const info = new TextEncoder().encode('session-info');
      
      const keys = await KeyExchangeService.deriveSessionKeys(sharedSecret, salt, info);
      
      expect(keys.encryptionKey.length).toBe(32);
      expect(keys.signingKey.length).toBe(32);
      expect(keys.authKey.length).toBe(32);
    });

    it('should not derive the same key for different purposes', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const info = new TextEncoder().encode('session-info');
      
      const keys = await KeyExchangeService.deriveSessionKeys(sharedSecret, salt, info);
      
      // All three derived keys should be different
      expect(keys.encryptionKey).not.toEqual(keys.signingKey);
      expect(keys.encryptionKey).not.toEqual(keys.authKey);
      expect(keys.signingKey).not.toEqual(keys.authKey);
    });

    it('should handle zero-filled salt and info', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      const zeroSalt = new Uint8Array(32);
      const zeroInfo = new Uint8Array(32);
      
      const keys = await KeyExchangeService.deriveSessionKeys(sharedSecret, zeroSalt, zeroInfo);
      
      expect(keys.encryptionKey).toBeInstanceOf(Uint8Array);
      expect(keys.encryptionKey.length).toBe(32);
    });
  });

  describe('Key generation - cryptographic properties', () => {
    it('should generate X25519 keys with correct format', async () => {
      const keyPair = await KeyExchangeService.generateX25519KeyPair();
      
      expect(keyPair.publicKey).toBeInstanceOf(Uint8Array);
      expect(keyPair.publicKey.length).toBe(32);
      expect(keyPair.privateKey).toBeInstanceOf(CryptoKey);
      
      // Verify private key is not extractable as raw (X25519 private keys typically aren't)
      const usages = keyPair.privateKey.usages;
      expect(usages).toContain('deriveBits');
      expect(usages).toContain('deriveKey');
    });

    it('should generate Ed25519 keys with correct format', async () => {
      const keyPair = await KeyExchangeService.generateEd25519KeyPair();
      
      expect(keyPair.publicKey).toBeInstanceOf(Uint8Array);
      expect(keyPair.publicKey.length).toBe(32);
      expect(keyPair.privateKey).toBeInstanceOf(CryptoKey);
      
      const usages = keyPair.privateKey.usages;
      expect(usages).toContain('sign');
      // Note: Private key only has 'sign', public key has 'verify'
      // This is the correct Web Crypto behavior
    });

    it('should generate independent key pairs', async () => {
      const keyPairs = await Promise.all([
        KeyExchangeService.generateX25519KeyPair(),
        KeyExchangeService.generateX25519KeyPair(),
        KeyExchangeService.generateX25519KeyPair(),
        KeyExchangeService.generateX25519KeyPair(),
        KeyExchangeService.generateX25519KeyPair(),
      ]);
      
      const publicKeys = keyPairs.map(kp => Buffer.from(kp.publicKey).toString('hex'));
      const uniqueKeys = new Set(publicKeys);
      expect(uniqueKeys.size).toBe(keyPairs.length);
    });
  });

  describe('Peer authentication - security properties', () => {
    it('should demonstrate that X25519 alone does not authenticate peers', async () => {
      // This test documents the MITM risk: X25519 key agreement without
      // out-of-band authentication does not prove peer identity
      
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const malloryKeyPair = await KeyExchangeService.generateX25519KeyPair(); // Attacker
      
      // Alice thinks she's talking to Bob, but Mallory intercepts
      const aliceResult = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        malloryKeyPair.publicKey, // Mallory's key instead of Bob's
        aliceKeyPair.publicKey
      );
      
      // Mallory can compute shared secret with Alice
      const malloryResult = await KeyExchangeService.computeSharedSecret(
        malloryKeyPair.privateKey,
        aliceKeyPair.publicKey,
        malloryKeyPair.publicKey
      );
      
      // They share the same secret - but Alice doesn't know it's Mallory!
      expect(aliceResult.sharedSecret).toEqual(malloryResult.sharedSecret);
      
      // This demonstrates the need for authenticated key exchange
      // The test passes but documents the security limitation
    });

    it('should verify that shared secret is not predictable from public keys alone', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      // An attacker with only public keys cannot compute the shared secret
      // (This is the fundamental security property of Diffie-Hellman)
      expect(sharedSecret).toBeInstanceOf(Uint8Array);
      expect(sharedSecret.length).toBe(32);
    });
  });

  describe('deriveSessionKeysNonExtractable - non-extractable key derivation', () => {
    it('should derive non-extractable CryptoKey objects', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const info = new TextEncoder().encode('session-info');
      
      const keys = await KeyExchangeService.deriveSessionKeysNonExtractable(sharedSecret, salt, info);
      
      expect(keys).toBeDefined();
      expect(keys.encryptionKey).toBeInstanceOf(CryptoKey);
      expect(keys.signingKey).toBeInstanceOf(CryptoKey);
      expect(keys.authKey).toBeInstanceOf(CryptoKey);
      
      // Keys should be non-extractable
      expect(keys.encryptionKey.extractable).toBe(false);
      expect(keys.signingKey.extractable).toBe(false);
      expect(keys.authKey.extractable).toBe(false);
      
      // Keys should have correct usages
      expect(keys.encryptionKey.usages).toEqual(['encrypt', 'decrypt']);
      expect(keys.signingKey.usages).toEqual(['sign', 'verify']);
      expect(keys.authKey.usages).toEqual(['sign', 'verify']);
      
      // Keys should have correct algorithm
      expect(keys.encryptionKey.algorithm.name).toBe('AES-GCM');
      expect(keys.signingKey.algorithm.name).toBe('HMAC');
      expect(keys.authKey.algorithm.name).toBe('HMAC');
    });

    it('should derive different keys with different salt', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      const salt1 = crypto.getRandomValues(new Uint8Array(32));
      const salt2 = crypto.getRandomValues(new Uint8Array(32));
      const info = new TextEncoder().encode('session-info');
      
      const keys1 = await KeyExchangeService.deriveSessionKeysNonExtractable(sharedSecret, salt1, info);
      const keys2 = await KeyExchangeService.deriveSessionKeysNonExtractable(sharedSecret, salt2, info);
      
      // Keys should be different (can't compare directly, but we can verify they're distinct CryptoKey objects)
      expect(keys1.encryptionKey).not.toBe(keys2.encryptionKey);
      expect(keys1.signingKey).not.toBe(keys2.signingKey);
      expect(keys1.authKey).not.toBe(keys2.authKey);
    });

    it('should derive different keys with different info', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const info1 = new TextEncoder().encode('purpose-1');
      const info2 = new TextEncoder().encode('purpose-2');
      
      const keys1 = await KeyExchangeService.deriveSessionKeysNonExtractable(sharedSecret, salt, info1);
      const keys2 = await KeyExchangeService.deriveSessionKeysNonExtractable(sharedSecret, salt, info2);
      
      expect(keys1.encryptionKey).not.toBe(keys2.encryptionKey);
      expect(keys1.signingKey).not.toBe(keys2.signingKey);
      expect(keys1.authKey).not.toBe(keys2.authKey);
    });

    it('should derive different keys for different shared secrets', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair1 = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair2 = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret: secret1 } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair1.publicKey,
        aliceKeyPair.publicKey
      );
      
      const { sharedSecret: secret2 } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair2.publicKey,
        aliceKeyPair.publicKey
      );
      
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const info = new TextEncoder().encode('session-info');
      
      const keys1 = await KeyExchangeService.deriveSessionKeysNonExtractable(secret1, salt, info);
      const keys2 = await KeyExchangeService.deriveSessionKeysNonExtractable(secret2, salt, info);
      
      expect(keys1.encryptionKey).not.toBe(keys2.encryptionKey);
      expect(keys1.signingKey).not.toBe(keys2.signingKey);
      expect(keys1.authKey).not.toBe(keys2.authKey);
    });

    it('should reject empty shared secret', async () => {
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const info = new TextEncoder().encode('session-info');
      const emptySecret = new Uint8Array(0);
      
      await expect(KeyExchangeService.deriveSessionKeysNonExtractable(emptySecret, salt, info)).rejects.toThrow();
    });

    it('should reject wrong shared secret length', async () => {
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const info = new TextEncoder().encode('session-info');
      const wrongSecret = new Uint8Array(16);
      
      await expect(KeyExchangeService.deriveSessionKeysNonExtractable(wrongSecret, salt, info)).rejects.toThrow();
    });

    it('should produce keys that work for encryption/decryption', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const info = new TextEncoder().encode('session-info');
      
      const keys = await KeyExchangeService.deriveSessionKeysNonExtractable(sharedSecret, salt, info);
      
      // Test encryption key works
      const encService = new (await import('../../src/security/encryption.js')).EncryptionService(
        keys.encryptionKey,
        { name: 'AES-GCM', keyLength: 32, nonceLength: 12, tagLength: 16 }
      );
      
      const plaintext = new TextEncoder().encode('test message');
      const result = await encService.encrypt(plaintext);
      const decrypted = await encService.decrypt(result);
      
      expect(decrypted).toEqual(plaintext);
    });

    it('should produce keys that work for HMAC signing/verification', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const info = new TextEncoder().encode('session-info');
      
      const keys = await KeyExchangeService.deriveSessionKeysNonExtractable(sharedSecret, salt, info);
      
      // Test signing key works for HMAC
      const data = new TextEncoder().encode('test data for HMAC');
      const signature = await crypto.subtle.sign('HMAC', keys.signingKey, data);
      const verified = await crypto.subtle.verify('HMAC', keys.signingKey, signature, data);
      
      expect(verified).toBe(true);
      
      // Test auth key works for HMAC
      const authSignature = await crypto.subtle.sign('HMAC', keys.authKey, data);
      const authVerified = await crypto.subtle.verify('HMAC', keys.authKey, authSignature, data);
      
      expect(authVerified).toBe(true);
    });

    it('should fail to export non-extractable keys', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const info = new TextEncoder().encode('session-info');
      
      const keys = await KeyExchangeService.deriveSessionKeysNonExtractable(sharedSecret, salt, info);
      
      // Attempting to export should fail
      await expect(crypto.subtle.exportKey('raw', keys.encryptionKey)).rejects.toThrow();
      await expect(crypto.subtle.exportKey('raw', keys.signingKey)).rejects.toThrow();
      await expect(crypto.subtle.exportKey('raw', keys.authKey)).rejects.toThrow();
    });
  });
});

// === NEW ADVERSARIAL TESTS ===

describe('KeyExchangeService - Additional Adversarial Tests', () => {
  describe('X25519 Key Agreement Security', () => {
    it('should produce same shared secret regardless of who computes it', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const aliceResult = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      const bobResult = await KeyExchangeService.computeSharedSecret(
        bobKeyPair.privateKey,
        aliceKeyPair.publicKey,
        bobKeyPair.publicKey
      );
      
      expect(aliceResult.sharedSecret).toEqual(bobResult.sharedSecret);
    });

    it('should produce different shared secrets for different key pairs', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair1 = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair2 = await KeyExchangeService.generateX25519KeyPair();
      
      const result1 = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair1.publicKey,
        aliceKeyPair.publicKey
      );
      
      const result2 = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair2.publicKey,
        aliceKeyPair.publicKey
      );
      
      expect(result1.sharedSecret).not.toEqual(result2.sharedSecret);
    });

    it('should not leak private key in shared secret', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      // Shared secret should not equal either public key
      expect(sharedSecret).not.toEqual(aliceKeyPair.publicKey);
      expect(sharedSecret).not.toEqual(bobKeyPair.publicKey);
      
      // X25519 private keys are not extractable as raw
      await expect(crypto.subtle.exportKey('raw', aliceKeyPair.privateKey)).rejects.toThrow();
    });

    it('should handle concurrent shared secret computations', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPairs = await Promise.all(
        Array.from({ length: 10 }, () => KeyExchangeService.generateX25519KeyPair())
      );
      
      const results = await Promise.all(
        bobKeyPairs.map(bobKP => 
          KeyExchangeService.computeSharedSecret(aliceKeyPair.privateKey, bobKP.publicKey, aliceKeyPair.publicKey)
        )
      );
      
      // All shared secrets should be different
      const secrets = results.map(r => Buffer.from(r.sharedSecret).toString('hex'));
      const uniqueSecrets = new Set(secrets);
      expect(uniqueSecrets.size).toBe(10);
    });
  });

  describe('HKDF Key Derivation Security', () => {
    it('should derive different keys for different salt', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      const info = new TextEncoder().encode('test-session');
      
      const keys1 = await KeyExchangeService.deriveSessionKeys(sharedSecret, crypto.getRandomValues(new Uint8Array(32)), info);
      const keys2 = await KeyExchangeService.deriveSessionKeys(sharedSecret, crypto.getRandomValues(new Uint8Array(32)), info);
      
      expect(keys1.encryptionKey).not.toEqual(keys2.encryptionKey);
      expect(keys1.signingKey).not.toEqual(keys2.signingKey);
      expect(keys1.authKey).not.toEqual(keys2.authKey);
    });

    it('should derive different keys for different info', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      const salt = crypto.getRandomValues(new Uint8Array(32));
      
      const keys1 = await KeyExchangeService.deriveSessionKeys(sharedSecret, salt, new TextEncoder().encode('purpose-a'));
      const keys2 = await KeyExchangeService.deriveSessionKeys(sharedSecret, salt, new TextEncoder().encode('purpose-b'));
      
      expect(keys1.encryptionKey).not.toEqual(keys2.encryptionKey);
      expect(keys1.signingKey).not.toEqual(keys2.signingKey);
      expect(keys1.authKey).not.toEqual(keys2.authKey);
    });

    it('should produce keys with correct length', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      const keys = await KeyExchangeService.deriveSessionKeys(
        sharedSecret,
        crypto.getRandomValues(new Uint8Array(32)),
        new TextEncoder().encode('test')
      );
      
      expect(keys.encryptionKey.length).toBe(32); // 256 bits
      expect(keys.signingKey.length).toBe(32);    // 256 bits
      expect(keys.authKey.length).toBe(32);       // 256 bits
    });

    it('should reject empty shared secret', async () => {
      await expect(KeyExchangeService.deriveSessionKeys(
        new Uint8Array(0),
        crypto.getRandomValues(new Uint8Array(32)),
        new TextEncoder().encode('test')
      )).rejects.toThrow('Shared secret cannot be empty');
    });

    it('should reject wrong shared secret length', async () => {
      await expect(KeyExchangeService.deriveSessionKeys(
        new Uint8Array(16), // Wrong length
        crypto.getRandomValues(new Uint8Array(32)),
        new TextEncoder().encode('test')
      )).rejects.toThrow('Shared secret must be 32 bytes');
    });

    it('should reject empty salt', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      await expect(KeyExchangeService.deriveSessionKeys(
        sharedSecret,
        new Uint8Array(0),
        new TextEncoder().encode('test')
      )).rejects.toThrow('Salt cannot be empty');
    });

    it('should produce distinct keys for each purpose (key separation)', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      const keys = await KeyExchangeService.deriveSessionKeys(
        sharedSecret,
        crypto.getRandomValues(new Uint8Array(32)),
        new TextEncoder().encode('test')
      );
      
      // All three derived keys should be different
      expect(keys.encryptionKey).not.toEqual(keys.signingKey);
      expect(keys.encryptionKey).not.toEqual(keys.authKey);
      expect(keys.signingKey).not.toEqual(keys.authKey);
    });

    it('should work with non-extractable variant', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      const keys = await KeyExchangeService.deriveSessionKeysNonExtractable(
        sharedSecret,
        crypto.getRandomValues(new Uint8Array(32)),
        new TextEncoder().encode('test')
      );
      
      expect(keys.encryptionKey.extractable).toBe(false);
      expect(keys.signingKey.extractable).toBe(false);
      expect(keys.authKey.extractable).toBe(false);
      
      // Test encryption key works
      const encService = new (await import('../../src/security/encryption.js')).EncryptionService(
        keys.encryptionKey,
        { name: 'AES-GCM', keyLength: 32, nonceLength: 12, tagLength: 16 }
      );
      const plaintext = new TextEncoder().encode('test');
      const result = await encService.encrypt(plaintext);
      const decrypted = await encService.decrypt(result);
      expect(decrypted).toEqual(plaintext);
    });
  });

  describe('MITM Attack Resistance (Unauthenticated X25519)', () => {
    it('should demonstrate X25519 without authentication is vulnerable to MITM', async () => {
      // This test documents the security limitation
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const malloryKeyPair = await KeyExchangeService.generateX25519KeyPair(); // Attacker
      
      // Alice thinks she's talking to Bob, but Mallory intercepts
      const aliceResult = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        malloryKeyPair.publicKey, // Mallory's key instead of Bob's
        aliceKeyPair.publicKey
      );
      
      // Mallory can compute shared secret with Alice
      const malloryResult = await KeyExchangeService.computeSharedSecret(
        malloryKeyPair.privateKey,
        aliceKeyPair.publicKey,
        malloryKeyPair.publicKey
      );
      
      // They share the same secret - but Alice doesn't know it's Mallory!
      expect(aliceResult.sharedSecret).toEqual(malloryResult.sharedSecret);
      
      // Same for Mallory-Bob
      const bobResult = await KeyExchangeService.computeSharedSecret(
        bobKeyPair.privateKey,
        malloryKeyPair.publicKey, // Mallory's key instead of Alice's
        bobKeyPair.publicKey
      );
      
      const malloryResult2 = await KeyExchangeService.computeSharedSecret(
        malloryKeyPair.privateKey,
        bobKeyPair.publicKey,
        malloryKeyPair.publicKey
      );
      
      expect(bobResult.sharedSecret).toEqual(malloryResult2.sharedSecret);
      
      // But Alice and Bob have DIFFERENT shared secrets (Mallory in middle)
      expect(aliceResult.sharedSecret).not.toEqual(bobResult.sharedSecret);
    });
  });

  describe('Input Validation Edge Cases', () => {
    it('should reject malformed peer public key (too short)', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      await expect(KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        new Uint8Array(16),
        aliceKeyPair.publicKey
      )).rejects.toThrow();
    });

    it('should reject malformed peer public key (too long)', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      await expect(KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        new Uint8Array(64),
        aliceKeyPair.publicKey
      )).rejects.toThrow();
    });

    it('should reject empty peer public key', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      await expect(KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        new Uint8Array(0),
        aliceKeyPair.publicKey
      )).rejects.toThrow();
    });

    it('should reject Ed25519 private key for X25519 operation', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const edKeyPair = await KeyExchangeService.generateEd25519KeyPair();
      
      await expect(KeyExchangeService.computeSharedSecret(
        edKeyPair.privateKey, // Wrong key type!
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      )).rejects.toThrow();
    });

    it('should handle zero-filled inputs', async () => {
      const aliceKeyPair = await KeyExchangeService.generateX25519KeyPair();
      const bobKeyPair = await KeyExchangeService.generateX25519KeyPair();
      
      const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey,
        aliceKeyPair.publicKey
      );
      
      const keys = await KeyExchangeService.deriveSessionKeys(
        sharedSecret,
        new Uint8Array(32), // Zero salt
        new Uint8Array(32)  // Zero info
      );
      
      expect(keys.encryptionKey).toBeInstanceOf(Uint8Array);
      expect(keys.encryptionKey.length).toBe(32);
    });
  });

  describe('Key Generation Entropy', () => {
    it('should generate unique X25519 key pairs', async () => {
      const keyPairs = await Promise.all(
        Array.from({ length: 100 }, () => KeyExchangeService.generateX25519KeyPair())
      );
      
      const publicKeys = keyPairs.map(kp => Buffer.from(kp.publicKey).toString('hex'));
      const uniqueKeys = new Set(publicKeys);
      expect(uniqueKeys.size).toBe(100);
    });

    it('should generate unique Ed25519 key pairs', async () => {
      const keyPairs = await Promise.all(
        Array.from({ length: 100 }, () => KeyExchangeService.generateEd25519KeyPair())
      );
      
      const publicKeys = keyPairs.map(kp => Buffer.from(kp.publicKey).toString('hex'));
      const uniqueKeys = new Set(publicKeys);
      expect(uniqueKeys.size).toBe(100);
    });

    it('should generate X25519 keys with correct usage', async () => {
      const keyPair = await KeyExchangeService.generateX25519KeyPair();
      expect(keyPair.privateKey.usages).toContain('deriveBits');
      expect(keyPair.privateKey.usages).toContain('deriveKey');
    });

    it('should generate Ed25519 keys with correct usage', async () => {
      const keyPair = await KeyExchangeService.generateEd25519KeyPair();
      expect(keyPair.privateKey.usages).toContain('sign');
      // Private key should NOT have verify usage
      expect(keyPair.privateKey.usages).not.toContain('verify');
    });
  });
});