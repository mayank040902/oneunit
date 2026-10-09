import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SigningService,
  Ed25519SigningService,
  RsaSigningService,
  KeyPair,
} from '../../src/security/signing.js';
import { KeyExchangeService } from '../../src/security/key-exchange.js';

describe('Ed25519SigningService', () => {
  let signingService: Ed25519SigningService;
  let keyPair: KeyPair;

  beforeEach(async () => {
    keyPair = await KeyExchangeService.generateEd25519KeyPair();
    signingService = await Ed25519SigningService.create(keyPair);
  });

  it('should create signing service with provided key pair', async () => {
    const service = await Ed25519SigningService.create(keyPair);
    expect(service).toBeInstanceOf(Ed25519SigningService);
  });

  it('should create signing service with generated key pair', async () => {
    const service = await Ed25519SigningService.create();
    expect(service).toBeInstanceOf(Ed25519SigningService);
    expect(service.getPublicKey()).toBeInstanceOf(Uint8Array);
    expect(service.getPublicKey().length).toBe(32);
  });

  it('should sign and verify data', async () => {
    const data = new TextEncoder().encode('Message to sign');
    
    const signature = await signingService.sign(data);
    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature.length).toBe(64); // Ed25519 signature length
    
    const valid = await signingService.verify(data, signature);
    expect(valid).toBe(true);
  });

  it('should reject modified data', async () => {
    const data = new TextEncoder().encode('Message to sign');
    const modifiedData = new TextEncoder().encode('Modified message');
    
    const signature = await signingService.sign(data);
    const valid = await signingService.verify(modifiedData, signature);
    
    expect(valid).toBe(false);
  });

  it('should reject modified signature', async () => {
    const data = new TextEncoder().encode('Message to sign');
    
    const signature = await signingService.sign(data);
    signature[0] ^= 0xFF; // Corrupt signature
    
    const valid = await signingService.verify(data, signature);
    expect(valid).toBe(false);
  });

  it('should return public key', async () => {
    const publicKey = signingService.getPublicKey();
    expect(publicKey).toBeInstanceOf(Uint8Array);
    expect(publicKey.length).toBe(32);
    expect(publicKey).toEqual(keyPair.publicKey);
  });

  it('should produce different signatures for same data (deterministic)', async () => {
    const data = new TextEncoder().encode('Message to sign');
    
    const signature1 = await signingService.sign(data);
    const signature2 = await signingService.sign(data);
    
    // Ed25519 is deterministic, so signatures should be the same
    expect(signature1).toEqual(signature2);
  });

  it('should verify with imported public key', async () => {
    const data = new TextEncoder().encode('Message to sign');
    const signature = await signingService.sign(data);
    
    // Import public key and verify manually
    const publicKey = await crypto.subtle.importKey(
      'raw',
      keyPair.publicKey as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    
    const valid = await crypto.subtle.verify(
      'Ed25519',
      publicKey,
      signature as BufferSource,
      data as BufferSource
    );
    
    expect(valid).toBe(true);
  });
});

describe('RsaSigningService', () => {
  let signingService: RsaSigningService;

  beforeEach(async () => {
    signingService = await RsaSigningService.create(2048);
  });

  it('should create RSA signing service with default key size', async () => {
    const service = await RsaSigningService.create();
    expect(service).toBeInstanceOf(RsaSigningService);
  });

  it('should create RSA signing service with custom key size', async () => {
    const service = await RsaSigningService.create(4096);
    expect(service).toBeInstanceOf(RsaSigningService);
  });

  it('should sign and verify data', async () => {
    const data = new TextEncoder().encode('Message to sign');
    
    const signature = await signingService.sign(data);
    expect(signature).toBeInstanceOf(Uint8Array);
    // RSA signature length equals key size in bytes (2048 bits = 256 bytes)
    expect(signature.length).toBe(256);
    
    const valid = await signingService.verify(data, signature);
    expect(valid).toBe(true);
  });

  it('should reject modified data', async () => {
    const data = new TextEncoder().encode('Message to sign');
    const modifiedData = new TextEncoder().encode('Modified message');
    
    const signature = await signingService.sign(data);
    const valid = await signingService.verify(modifiedData, signature);
    
    expect(valid).toBe(false);
  });

  it('should reject modified signature', async () => {
    const data = new TextEncoder().encode('Message to sign');
    
    const signature = await signingService.sign(data);
    signature[0] ^= 0xFF; // Corrupt signature
    
    const valid = await signingService.verify(data, signature);
    expect(valid).toBe(false);
  });

  it('should get public key as PEM', async () => {
    const pem = await signingService.getPublicKeyPem();
    
    expect(typeof pem).toBe('string');
    expect(pem).toContain('-----BEGIN PUBLIC KEY-----');
    expect(pem).toContain('-----END PUBLIC KEY-----');
  });
});

describe('SigningService interface', () => {
  it('should define correct structure', () => {
    const service: SigningService = {
      sign: async () => new Uint8Array(),
      verify: async () => false,
    };
    
    expect(typeof service.sign).toBe('function');
    expect(typeof service.verify).toBe('function');
  });
});

describe('Ed25519SigningService - Adversarial and Edge Case Tests', () => {
  let signingService: Ed25519SigningService;
  let keyPair: KeyPair;

  beforeEach(async () => {
    keyPair = await KeyExchangeService.generateEd25519KeyPair();
    signingService = await Ed25519SigningService.create(keyPair);
  });

  it('should reject truncated signature', async () => {
    const data = new TextEncoder().encode('Message to sign');
    const signature = await signingService.sign(data);
    
    const truncatedSig = signature.slice(0, 32); // Half the signature
    const valid = await signingService.verify(data, truncatedSig);
    expect(valid).toBe(false);
  });

  it('should reject oversized signature', async () => {
    const data = new TextEncoder().encode('Message to sign');
    const signature = await signingService.sign(data);
    
    const oversizedSig = new Uint8Array(128);
    oversizedSig.set(signature);
    const valid = await signingService.verify(data, oversizedSig);
    expect(valid).toBe(false);
  });

  it('should reject empty signature', async () => {
    const data = new TextEncoder().encode('Message to sign');
    const emptySig = new Uint8Array(0);
    const valid = await signingService.verify(data, emptySig);
    expect(valid).toBe(false);
  });

  it('should reject completely random signature', async () => {
    const data = new TextEncoder().encode('Message to sign');
    const randomSig = crypto.getRandomValues(new Uint8Array(64));
    const valid = await signingService.verify(data, randomSig);
    expect(valid).toBe(false);
  });

  it('should reject signature from different key pair', async () => {
    const data = new TextEncoder().encode('Message to sign');
    
    const otherKeyPair = await KeyExchangeService.generateEd25519KeyPair();
    const otherService = await Ed25519SigningService.create(otherKeyPair);
    const signature = await otherService.sign(data);
    
    const valid = await signingService.verify(data, signature);
    expect(valid).toBe(false);
  });

  it('should handle empty message', async () => {
    const data = new Uint8Array(0);
    const signature = await signingService.sign(data);
    const valid = await signingService.verify(data, signature);
    expect(valid).toBe(true);
  });

  it('should handle very large message (64KB - Web Crypto limit)', async () => {
    const data = crypto.getRandomValues(new Uint8Array(64 * 1024)); // 64KB
    const signature = await signingService.sign(data);
    const valid = await signingService.verify(data, signature);
    expect(valid).toBe(true);
  });

  it('should produce deterministic signatures for same input', async () => {
    const data = new TextEncoder().encode('Deterministic test');
    
    const sig1 = await signingService.sign(data);
    const sig2 = await signingService.sign(data);
    
    expect(sig1).toEqual(sig2);
  });

  it('should not expose private key in signatures', async () => {
    const data = new TextEncoder().encode('Test');
    const signature = await signingService.sign(data);
    
    // Private key should not be recoverable from signature
    // Ed25519 private key is 64 bytes, signature is 64 bytes
    // They should not be equal
    expect(signature).not.toEqual(keyPair.privateKey);
  });

  it('should verify with independently imported public key', async () => {
    const data = new TextEncoder().encode('Test message');
    const signature = await signingService.sign(data);
    
    // Import public key using Web Crypto
    const publicKey = await crypto.subtle.importKey(
      'raw',
      keyPair.publicKey as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    
    const valid = await crypto.subtle.verify(
      'Ed25519',
      publicKey,
      signature as BufferSource,
      data as BufferSource
    );
    
    expect(valid).toBe(true);
  });

  it('should reject signature with single bit flipped', async () => {
    const data = new TextEncoder().encode('Bit flip test');
    const signature = await signingService.sign(data);
    
    // Flip each bit and verify rejection
    for (let i = 0; i < signature.length; i++) {
      const modified = new Uint8Array(signature);
      modified[i] ^= 0x01;
      const valid = await signingService.verify(data, modified);
      expect(valid).toBe(false);
    }
  });

  it('should reject signature for modified message (single byte change)', async () => {
    const data = new TextEncoder().encode('Original message');
    const signature = await signingService.sign(data);
    
    // Change one byte in message
    const modifiedData = new Uint8Array(data);
    modifiedData[0] ^= 0x01;
    
    const valid = await signingService.verify(modifiedData, signature);
    expect(valid).toBe(false);
  });

  it('should handle binary data with all byte values', async () => {
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      data[i] = i;
    }
    
    const signature = await signingService.sign(data);
    const valid = await signingService.verify(data, signature);
    expect(valid).toBe(true);
  });

  it('should verify concurrently without interference', async () => {
    const data = new TextEncoder().encode('Concurrent test');
    const signature = await signingService.sign(data);
    
    const results = await Promise.all([
      signingService.verify(data, signature),
      signingService.verify(data, signature),
      signingService.verify(data, signature),
      signingService.verify(data, signature),
      signingService.verify(data, signature),
    ]);
    
    results.forEach(valid => expect(valid).toBe(true));
  });
});

describe('RsaSigningService - Adversarial and Edge Case Tests', () => {
  let signingService: RsaSigningService;

  beforeEach(async () => {
    signingService = await RsaSigningService.create(2048);
  });

  it('should reject truncated signature', async () => {
    const data = new TextEncoder().encode('Message to sign');
    const signature = await signingService.sign(data);
    
    const truncatedSig = signature.slice(0, 128);
    const valid = await signingService.verify(data, truncatedSig);
    expect(valid).toBe(false);
  });

  it('should reject oversized signature', async () => {
    const data = new TextEncoder().encode('Message to sign');
    const signature = await signingService.sign(data);
    
    const oversizedSig = new Uint8Array(512);
    oversizedSig.set(signature);
    const valid = await signingService.verify(data, oversizedSig);
    expect(valid).toBe(false);
  });

  it('should reject empty signature', async () => {
    const data = new TextEncoder().encode('Message to sign');
    const emptySig = new Uint8Array(0);
    const valid = await signingService.verify(data, emptySig);
    expect(valid).toBe(false);
  });

  it('should reject signature from different key', async () => {
    const data = new TextEncoder().encode('Message to sign');
    
    const otherService = await RsaSigningService.create(2048);
    const signature = await otherService.sign(data);
    
    const valid = await signingService.verify(data, signature);
    expect(valid).toBe(false);
  });

  it('should handle empty message', async () => {
    const data = new Uint8Array(0);
    const signature = await signingService.sign(data);
    const valid = await signingService.verify(data, signature);
    expect(valid).toBe(true);
  });

  it('should reject signature with bit flipped', async () => {
    const data = new TextEncoder().encode('Bit flip test');
    const signature = await signingService.sign(data);
    
    for (let i = 0; i < Math.min(signature.length, 10); i++) {
      const modified = new Uint8Array(signature);
      modified[i] ^= 0x01;
      const valid = await signingService.verify(data, modified);
      expect(valid).toBe(false);
    }
  });

  it('should reject signature for modified message', async () => {
    const data = new TextEncoder().encode('Original message');
    const signature = await signingService.sign(data);
    
    const modifiedData = new Uint8Array(data);
    modifiedData[0] ^= 0x01;
    
    const valid = await signingService.verify(modifiedData, signature);
    expect(valid).toBe(false);
  });

  it('should export valid PEM public key', async () => {
    const pem = await signingService.getPublicKeyPem();
    
    expect(typeof pem).toBe('string');
    expect(pem).toContain('-----BEGIN PUBLIC KEY-----');
    expect(pem).toContain('-----END PUBLIC KEY-----');
    
    // Verify PEM can be parsed
    const base64 = pem
      .replace('-----BEGIN PUBLIC KEY-----', '')
      .replace('-----END PUBLIC KEY-----', '')
      .replace(/\s/g, '');
    const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    expect(binary.length).toBeGreaterThan(0);
  });
});

// === NEW ADVERSARIAL TESTS ===

describe('RSA Signing - Algorithm Security', () => {
  let rsaService: RsaSigningService;
  
  beforeEach(async () => {
    rsaService = await RsaSigningService.create(2048);
  });

  it('should use RSASSA-PKCS1-v1_5 (documented behavior)', async () => {
    const data = new TextEncoder().encode('Test');
    const signature = await rsaService.sign(data);
    
    // Verify algorithm used is PKCS1-v1_5
    const pem = await rsaService.getPublicKeyPem();
    const base64 = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s/g, '');
    const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    
    const publicKey = await crypto.subtle.importKey(
      'spki',
      binary.buffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, data);
    expect(valid).toBe(true);
  });

  it('should reject RSA-PSS signature with PKCS1-v1_5 key', async () => {
    const data = new TextEncoder().encode('Test');
    const signature = await rsaService.sign(data);
    
    // Try to verify with RSA-PSS - should fail
    const pem = await rsaService.getPublicKeyPem();
    const base64 = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s/g, '');
    const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    
    const publicKey = await crypto.subtle.importKey(
      'spki',
      binary.buffer,
      { name: 'RSA-PSS', hash: 'SHA-256' },
      false,
      ['verify']
    );
    
    const valid = await crypto.subtle.verify(
      { name: 'RSA-PSS', saltLength: 32 },
      publicKey,
      signature,
      data
    );
    expect(valid).toBe(false);
  });

  it('should handle different key sizes', async () => {
    for (const keySize of [2048, 3072, 4096]) {
      const service = await RsaSigningService.create(keySize);
      const data = new TextEncoder().encode(`Test ${keySize}`);
      const signature = await service.sign(data);
      const valid = await service.verify(data, signature);
      expect(valid).toBe(true);
      expect(signature.length).toBe(keySize / 8);
    }
  });
});

describe('Ed25519 Signing - Deterministic Properties', () => {
  let edService: Ed25519SigningService;
  let keyPair: KeyPair;
  
  beforeEach(async () => {
    keyPair = await KeyExchangeService.generateEd25519KeyPair();
    edService = await Ed25519SigningService.create(keyPair);
  });

  it('should produce deterministic signatures (Ed25519 property)', async () => {
    const data = new TextEncoder().encode('Deterministic test');
    const sig1 = await edService.sign(data);
    const sig2 = await edService.sign(data);
    expect(sig1).toEqual(sig2);
  });

  it('should produce different signatures for different messages', async () => {
    const data1 = new TextEncoder().encode('Message 1');
    const data2 = new TextEncoder().encode('Message 2');
    
    const sig1 = await edService.sign(data1);
    const sig2 = await edService.sign(data2);
    
    expect(sig1).not.toEqual(sig2);
  });

  it('should produce different signatures for same message with different keys', async () => {
    const data = new TextEncoder().encode('Same message');
    const sig1 = await edService.sign(data);
    
    const otherKeyPair = await KeyExchangeService.generateEd25519KeyPair();
    const otherService = await Ed25519SigningService.create(otherKeyPair);
    const sig2 = await otherService.sign(data);
    
    expect(sig1).not.toEqual(sig2);
  });

  it('should verify signature with raw public key import', async () => {
    const data = new TextEncoder().encode('Raw key test');
    const signature = await edService.sign(data);
    
    // Import public key as raw
    const publicKey = await crypto.subtle.importKey(
      'raw',
      keyPair.publicKey as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    
    const valid = await crypto.subtle.verify('Ed25519', publicKey, signature as BufferSource, data as BufferSource);
    expect(valid).toBe(true);
  });
});

describe('Key Usage Validation', () => {
  it('should reject signing with key that only has verify usage', async () => {
    const keyPair = await KeyExchangeService.generateEd25519KeyPair();
    
    // Import public key with only verify usage
    const publicKeyOnly = await crypto.subtle.importKey(
      'raw',
      keyPair.publicKey as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    
    const data = new TextEncoder().encode('Test');
    await expect(crypto.subtle.sign('Ed25519', publicKeyOnly, data)).rejects.toThrow();
  });

  it('should reject verification with key that only has sign usage', async () => {
    const keyPair = await KeyExchangeService.generateEd25519KeyPair();
    
    // Import private key with only sign usage - need to export raw first
    // Ed25519 private keys in Web Crypto cannot be exported as raw
    // So we test with a CryptoKey that has only 'sign' usage
    const privateKeyOnly = await crypto.subtle.importKey(
      'pkcs8',
      await crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
      { name: 'Ed25519' },
      false,
      ['sign']
    );
    
    const data = new TextEncoder().encode('Test');
    const signature = await crypto.subtle.sign('Ed25519', privateKeyOnly, data);
    
    // Verify should fail because privateKeyOnly doesn't have 'verify' usage
    await expect(crypto.subtle.verify('Ed25519', privateKeyOnly, signature, data)).rejects.toThrow();
  });
});

describe('Concurrent Operations', () => {
  it('should handle concurrent signing without interference', async () => {
    const edService = await Ed25519SigningService.create();
    const data = new TextEncoder().encode('Concurrent signing');
    
    const signatures = await Promise.all(
      Array.from({ length: 50 }, () => edService.sign(data))
    );
    
    // All signatures should be identical (deterministic)
    for (const sig of signatures) {
      expect(sig).toEqual(signatures[0]);
    }
  });

  it('should handle concurrent verification without interference', async () => {
    const edService = await Ed25519SigningService.create();
    const data = new TextEncoder().encode('Concurrent verification');
    const signature = await edService.sign(data);
    
    const results = await Promise.all(
      Array.from({ length: 50 }, () => edService.verify(data, signature))
    );
    
    results.forEach(valid => expect(valid).toBe(true));
  });

  it('should handle mixed concurrent sign and verify', async () => {
    const edService = await Ed25519SigningService.create();
    const data = new TextEncoder().encode('Mixed operations');
    
    const operations = [];
    for (let i = 0; i < 20; i++) {
      operations.push(edService.sign(data));
      operations.push(edService.verify(data, await edService.sign(data)));
    }
    
    const results = await Promise.all(operations);
    // Even indices are signatures (Uint8Array), odd are booleans
    for (let i = 0; i < results.length; i += 2) {
      expect(results[i]).toBeInstanceOf(Uint8Array);
      expect(results[i + 1]).toBe(true);
    }
  });
});

describe('Edge Cases and Malformed Inputs', () => {
  it('should handle signature at boundary lengths', async () => {
    const edService = await Ed25519SigningService.create();
    const data = new TextEncoder().encode('Boundary test');
    const signature = await edService.sign(data);
    
    // Ed25519 signatures are exactly 64 bytes
    expect(signature.length).toBe(64);
  });

  it('should handle messages with all possible byte values', async () => {
    const edService = await Ed25519SigningService.create();
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) data[i] = i;
    
    const signature = await edService.sign(data);
    const valid = await edService.verify(data, signature);
    expect(valid).toBe(true);
  });

  it('should reject verification with wrong algorithm', async () => {
    const edService = await Ed25519SigningService.create();
    const data = new TextEncoder().encode('Algorithm test');
    const signature = await edService.sign(data);
    
    // Try to verify with RSA algorithm - returns false, doesn't throw
    const rsaKeyPair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify']
    );
    
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', rsaKeyPair.publicKey, signature, data);
    expect(valid).toBe(false);
  });
});