export type KeyPair = {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
};

export type SymmetricKey = Uint8Array & { readonly __brand: unique symbol };

export type Nonce = Uint8Array & { readonly __brand: unique symbol };

export type AuthTag = Uint8Array & { readonly __brand: unique symbol };

export interface EncryptionResult {
  ciphertext: Uint8Array;
  nonce: Nonce;
  tag: AuthTag;
}

export interface DecryptionInput {
  ciphertext: Uint8Array;
  nonce: Nonce;
  tag: AuthTag;
  associatedData?: Uint8Array;
}

export interface KeyExchangeResult {
  sharedSecret: Uint8Array;
  publicKey: Uint8Array;
}

export interface DerivedKeys {
  encryptionKey: SymmetricKey;
  signingKey: Uint8Array;
  authKey: Uint8Array;
}

export interface SessionKeys {
  sessionId: string;
  keys: DerivedKeys;
  createdAt: number;
  expiresAt: number;
  peerId: string;
}

export interface CryptoAlgorithm {
  name: string;
  keyLength: number;
  nonceLength: number;
  tagLength: number;
}

export const SUPPORTED_ALGORITHMS: Record<string, CryptoAlgorithm> = {
  'aes-256-gcm': {
    name: 'AES-GCM',
    keyLength: 32,
    nonceLength: 12,
    tagLength: 16,
  },
  'chacha20-poly1305': {
    name: 'CHACHA20-POLY1305',
    keyLength: 32,
    nonceLength: 12,
    tagLength: 16,
  },
  'x25519': {
    name: 'X25519',
    keyLength: 32,
    nonceLength: 0,
    tagLength: 0,
  },
  'ed25519': {
    name: 'Ed25519',
    keyLength: 32,
    nonceLength: 0,
    tagLength: 64,
  },
  'hkdf-sha256': {
    name: 'HKDF-SHA256',
    keyLength: 32,
    nonceLength: 0,
    tagLength: 0,
  },
};

export interface SigningKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface VerificationResult {
  valid: boolean;
  error?: string;
}

export interface KeyRotationPolicy {
  interval: number;
  gracePeriod: number;
  maxKeys: number;
}