import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_ALGORITHMS,
  CryptoAlgorithm,
  KeyPair,
  SymmetricKey,
  Nonce,
  AuthTag,
  EncryptionResult,
  DecryptionInput,
  KeyExchangeResult,
  DerivedKeys,
  SessionKeys,
  SigningKeyPair,
  VerificationResult,
  KeyRotationPolicy,
} from '../../src/security/crypto-types.js';

describe('SUPPORTED_ALGORITHMS', () => {
  it('should define aes-256-gcm algorithm', () => {
    const algo = SUPPORTED_ALGORITHMS['aes-256-gcm'];
    expect(algo).toBeDefined();
    expect(algo.name).toBe('AES-GCM');
    expect(algo.keyLength).toBe(32);
    expect(algo.nonceLength).toBe(12);
    expect(algo.tagLength).toBe(16);
  });

  it('should define chacha20-poly1305 algorithm', () => {
    const algo = SUPPORTED_ALGORITHMS['chacha20-poly1305'];
    expect(algo).toBeDefined();
    expect(algo.name).toBe('CHACHA20-POLY1305');
    expect(algo.keyLength).toBe(32);
    expect(algo.nonceLength).toBe(12);
    expect(algo.tagLength).toBe(16);
  });

  it('should define x25519 algorithm', () => {
    const algo = SUPPORTED_ALGORITHMS['x25519'];
    expect(algo).toBeDefined();
    expect(algo.name).toBe('X25519');
    expect(algo.keyLength).toBe(32);
    expect(algo.nonceLength).toBe(0);
    expect(algo.tagLength).toBe(0);
  });

  it('should define ed25519 algorithm', () => {
    const algo = SUPPORTED_ALGORITHMS['ed25519'];
    expect(algo).toBeDefined();
    expect(algo.name).toBe('Ed25519');
    expect(algo.keyLength).toBe(32);
    expect(algo.nonceLength).toBe(0);
    expect(algo.tagLength).toBe(64);
  });

  it('should define hkdf-sha256 algorithm', () => {
    const algo = SUPPORTED_ALGORITHMS['hkdf-sha256'];
    expect(algo).toBeDefined();
    expect(algo.name).toBe('HKDF-SHA256');
    expect(algo.keyLength).toBe(32);
    expect(algo.nonceLength).toBe(0);
    expect(algo.tagLength).toBe(0);
  });

  it('should have exactly 5 algorithms', () => {
    expect(Object.keys(SUPPORTED_ALGORITHMS)).toHaveLength(5);
  });
});

describe('CryptoAlgorithm', () => {
  it('should define correct structure', () => {
    const algo: CryptoAlgorithm = {
      name: 'Test',
      keyLength: 32,
      nonceLength: 12,
      tagLength: 16,
    };
    
    expect(algo.name).toBe('Test');
    expect(algo.keyLength).toBe(32);
  });
});

describe('KeyPair', () => {
  it('should define correct structure', () => {
    const keyPair: KeyPair = {
      publicKey: new Uint8Array(32),
      privateKey: new Uint8Array(32),
    };
    
    expect(keyPair.publicKey.length).toBe(32);
    expect(keyPair.privateKey.length).toBe(32);
  });
});

describe('SymmetricKey (branded)', () => {
  it('should be Uint8Array with brand', () => {
    const key = new Uint8Array(32) as SymmetricKey;
    expect(key.length).toBe(32);
    expect(key).toBeInstanceOf(Uint8Array);
  });
});

describe('Nonce (branded)', () => {
  it('should be Uint8Array with brand', () => {
    const nonce = new Uint8Array(12) as Nonce;
    expect(nonce.length).toBe(12);
    expect(nonce).toBeInstanceOf(Uint8Array);
  });
});

describe('AuthTag (branded)', () => {
  it('should be Uint8Array with brand', () => {
    const tag = new Uint8Array(16) as AuthTag;
    expect(tag.length).toBe(16);
    expect(tag).toBeInstanceOf(Uint8Array);
  });
});

describe('EncryptionResult', () => {
  it('should define correct structure', () => {
    const result: EncryptionResult = {
      ciphertext: new Uint8Array(32),
      nonce: new Uint8Array(12) as Nonce,
      tag: new Uint8Array(16) as AuthTag,
    };
    
    expect(result.ciphertext.length).toBe(32);
    expect(result.nonce.length).toBe(12);
    expect(result.tag.length).toBe(16);
  });
});

describe('DecryptionInput', () => {
  it('should define correct structure', () => {
    const input: DecryptionInput = {
      ciphertext: new Uint8Array(32),
      nonce: new Uint8Array(12) as Nonce,
      tag: new Uint8Array(16) as AuthTag,
      associatedData: new Uint8Array(16),
    };
    
    expect(input.ciphertext.length).toBe(32);
    expect(input.nonce.length).toBe(12);
    expect(input.tag.length).toBe(16);
    expect(input.associatedData?.length).toBe(16);
  });

  it('should allow optional associatedData', () => {
    const input: DecryptionInput = {
      ciphertext: new Uint8Array(32),
      nonce: new Uint8Array(12) as Nonce,
      tag: new Uint8Array(16) as AuthTag,
    };
    
    expect(input.associatedData).toBeUndefined();
  });
});

describe('KeyExchangeResult', () => {
  it('should define correct structure', () => {
    const result: KeyExchangeResult = {
      sharedSecret: new Uint8Array(32),
      publicKey: new Uint8Array(32),
    };
    
    expect(result.sharedSecret.length).toBe(32);
    expect(result.publicKey.length).toBe(32);
  });
});

describe('DerivedKeys', () => {
  it('should define correct structure', () => {
    const keys: DerivedKeys = {
      encryptionKey: new Uint8Array(32) as SymmetricKey,
      signingKey: new Uint8Array(32),
      authKey: new Uint8Array(32),
    };
    
    expect(keys.encryptionKey.length).toBe(32);
    expect(keys.signingKey.length).toBe(32);
    expect(keys.authKey.length).toBe(32);
  });
});

describe('SessionKeys', () => {
  it('should define correct structure', () => {
    const sessionKeys: SessionKeys = {
      sessionId: 'session-123',
      keys: {
        encryptionKey: new Uint8Array(32) as SymmetricKey,
        signingKey: new Uint8Array(32),
        authKey: new Uint8Array(32),
      },
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      peerId: 'peer-456',
    };
    
    expect(sessionKeys.sessionId).toBe('session-123');
    expect(sessionKeys.peerId).toBe('peer-456');
    expect(sessionKeys.createdAt).toBeDefined();
    expect(sessionKeys.expiresAt).toBeGreaterThan(sessionKeys.createdAt);
  });
});

describe('SigningKeyPair', () => {
  it('should define correct structure', () => {
    const keyPair: SigningKeyPair = {
      publicKey: new Uint8Array(32),
      privateKey: new Uint8Array(64),
    };
    
    expect(keyPair.publicKey.length).toBe(32);
    expect(keyPair.privateKey.length).toBe(64);
  });
});

describe('VerificationResult', () => {
  it('should define correct structure for valid', () => {
    const result: VerificationResult = {
      valid: true,
    };
    
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should define correct structure for invalid', () => {
    const result: VerificationResult = {
      valid: false,
      error: 'Signature mismatch',
    };
    
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Signature mismatch');
  });
});

describe('KeyRotationPolicy', () => {
  it('should define correct structure', () => {
    const policy: KeyRotationPolicy = {
      interval: 86400000,
      gracePeriod: 3600000,
      maxKeys: 3,
    };
    
    expect(policy.interval).toBe(86400000);
    expect(policy.gracePeriod).toBe(3600000);
    expect(policy.maxKeys).toBe(3);
  });
});