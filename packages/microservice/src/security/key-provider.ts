import { EncryptionService } from './encryption.js';
import { KeyExchangeService } from './key-exchange.js';
import { Ed25519SigningService } from './signing.js';
import { ServiceIdentity } from '../identity/service-identity.js';

export interface KeyProvider {
  getEncryptionKey(serviceId: string): Promise<EncryptionService | null>;
  getSigningKey(serviceId: string): Promise<Ed25519SigningService | null>;
  getKeyExchangeKey(serviceId: string): Promise<{ publicKey: Uint8Array; privateKey: CryptoKey } | null>;
  storeKeys(serviceId: string, keys: ServiceKeys): Promise<void>;
  rotateKeys(serviceId: string): Promise<ServiceKeys>;
  revokeKeys(serviceId: string): Promise<void>;
  getKeyVersion(serviceId: string): Promise<number>;
}

export interface ServiceKeys {
  encryptionKey: Uint8Array;
  signingKeyPair: { publicKey: Uint8Array; privateKey: CryptoKey };
  keyExchangeKeyPair: { publicKey: Uint8Array; privateKey: CryptoKey };
  issuedAt: number;
  expiresAt: number;
  version: number;
}

export class MemoryKeyProvider implements KeyProvider {
  private store: Map<string, ServiceKeys> = new Map();
  private defaultTtlMs: number;

  constructor(defaultTtlMs = 24 * 60 * 60 * 1000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  async getEncryptionKey(serviceId: string): Promise<EncryptionService | null> {
    const keys = this.store.get(serviceId);
    if (!keys || this.isExpired(keys)) return null;
    return EncryptionService.create('aes-256-gcm', keys.encryptionKey);
  }

  async getSigningKey(serviceId: string): Promise<Ed25519SigningService | null> {
    const keys = this.store.get(serviceId);
    if (!keys || this.isExpired(keys)) return null;
    return Ed25519SigningService.create(keys.signingKeyPair);
  }

  async getKeyExchangeKey(serviceId: string): Promise<{ publicKey: Uint8Array; privateKey: CryptoKey } | null> {
    const keys = this.store.get(serviceId);
    if (!keys || this.isExpired(keys)) return null;
    return keys.keyExchangeKeyPair;
  }

  async storeKeys(serviceId: string, keys: ServiceKeys): Promise<void> {
    this.store.set(serviceId, keys);
  }

  async rotateKeys(serviceId: string): Promise<ServiceKeys> {
    const oldKeys = this.store.get(serviceId);
    const version = (oldKeys?.version ?? 0) + 1;
    const issuedAt = Date.now();

    const [encryptionKey, signingKeyPair, keyExchangeKeyPair] = await Promise.all([
      EncryptionService.generateKey('aes-256-gcm'),
      KeyExchangeService.generateEd25519KeyPair(),
      KeyExchangeService.generateX25519KeyPair(),
    ]);

    const newKeys: ServiceKeys = {
      encryptionKey,
      signingKeyPair,
      keyExchangeKeyPair,
      issuedAt,
      expiresAt: issuedAt + this.defaultTtlMs,
      version,
    };

    await this.storeKeys(serviceId, newKeys);
    return newKeys;
  }

  async revokeKeys(serviceId: string): Promise<void> {
    this.store.delete(serviceId);
  }

  async getKeyVersion(serviceId: string): Promise<number> {
    const keys = this.store.get(serviceId);
    if (!keys || this.isExpired(keys)) return 0;
    return keys.version;
  }

  private isExpired(keys: ServiceKeys): boolean {
    return Date.now() > keys.expiresAt;
  }
}

export class CompositeKeyProvider implements KeyProvider {
  private providers: KeyProvider[] = [];

  addProvider(provider: KeyProvider): void {
    this.providers.push(provider);
  }

  async getEncryptionKey(serviceId: string): Promise<EncryptionService | null> {
    for (const provider of this.providers) {
      const key = await provider.getEncryptionKey(serviceId);
      if (key) return key;
    }
    return null;
  }

  async getSigningKey(serviceId: string): Promise<Ed25519SigningService | null> {
    for (const provider of this.providers) {
      const key = await provider.getSigningKey(serviceId);
      if (key) return key;
    }
    return null;
  }

  async getKeyExchangeKey(serviceId: string): Promise<{ publicKey: Uint8Array; privateKey: CryptoKey } | null> {
    for (const provider of this.providers) {
      const key = await provider.getKeyExchangeKey(serviceId);
      if (key) return key;
    }
    return null;
  }

  async storeKeys(serviceId: string, keys: ServiceKeys): Promise<void> {
    await Promise.all(this.providers.map(p => p.storeKeys(serviceId, keys)));
  }

  async rotateKeys(serviceId: string): Promise<ServiceKeys> {
    if (this.providers.length === 0) {
      throw new Error('No key providers available');
    }
    const provider = this.providers[0];
    if (!provider) {
      throw new Error('No key providers available');
    }
    return provider.rotateKeys(serviceId);
  }

  async revokeKeys(serviceId: string): Promise<void> {
    await Promise.all(this.providers.map(p => p.revokeKeys(serviceId)));
  }

  async getKeyVersion(serviceId: string): Promise<number> {
    for (const provider of this.providers) {
      const version = await provider.getKeyVersion(serviceId);
      if (version > 0) return version;
    }
    return 0;
  }
}

export function createKeyProvider(
  type: 'memory' | 'composite',
  options?: { defaultTtlMs?: number }
): KeyProvider {
  switch (type) {
    case 'memory':
      return new MemoryKeyProvider(options?.defaultTtlMs);
    case 'composite':
      return new CompositeKeyProvider();
    default:
      throw new Error(`Unknown key provider type: ${type}`);
  }
}