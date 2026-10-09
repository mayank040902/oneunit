import { KeyPair, SymmetricKey, EncryptionResult, DecryptionInput, KeyExchangeResult, DerivedKeys, SessionKeys, CryptoAlgorithm, SigningKeyPair, VerificationResult } from '../security/crypto-types.js';

export interface KeyManager {
  generateKeyPair(algorithm: 'ed25519' | 'x25519'): Promise<KeyPair>;
  generateSymmetricKey(algorithm: string): Promise<SymmetricKey>;
  deriveKeys(sharedSecret: Uint8Array, salt: Uint8Array, info: Uint8Array): Promise<DerivedKeys>;
  rotateKeys(sessionId: string): Promise<SessionKeys>;
  getKeyPair(serviceId: string): Promise<KeyPair | null>;
  storeKeyPair(serviceId: string, keyPair: KeyPair): Promise<void>;
  deleteKeyPair(serviceId: string): Promise<void>;
}

export interface EncryptionService {
  encrypt(key: SymmetricKey, plaintext: Uint8Array, associatedData?: Uint8Array): Promise<EncryptionResult>;
  decrypt(key: SymmetricKey, input: DecryptionInput): Promise<Uint8Array>;
  getAlgorithm(): CryptoAlgorithm;
}

export interface SigningService {
  sign(keyPair: SigningKeyPair, data: Uint8Array): Promise<Uint8Array>;
  verify(publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array): Promise<VerificationResult>;
}

export interface KeyExchangeService {
  generateEphemeralKeyPair(): Promise<KeyPair>;
  computeSharedSecret(privateKey: Uint8Array, peerPublicKey: Uint8Array): Promise<KeyExchangeResult>;
  createSessionKeys(sharedSecret: Uint8Array, sessionId: string, peerId: string): Promise<SessionKeys>;
}

export interface CryptoProvider {
  keys: KeyManager;
  encryption: EncryptionService;
  signing: SigningService;
  keyExchange: KeyExchangeService;

  initialize(config: CryptoConfig): Promise<void>;
  shutdown(): Promise<void>;
}

export interface CryptoConfig {
  algorithms: {
    encryption: string;
    signing: string;
    keyExchange: string;
    keyDerivation: string;
  };
  keyRotation: {
    enabled: boolean;
    interval: number;
    gracePeriod: number;
  };
  storage: {
    type: 'memory' | 'file' | 'hsm';
    path?: string;
  };
}

export const CRYPTO_EVENTS = {
  KEY_GENERATED: 'key:generated',
  KEY_ROTATED: 'key:rotated',
  KEY_EXPIRED: 'key:expired',
  ENCRYPTION_FAILED: 'encryption:failed',
  DECRYPTION_FAILED: 'decryption:failed',
  SIGNATURE_FAILED: 'signature:failed',
  VERIFICATION_FAILED: 'verification:failed',
} as const;