import { EncryptionService } from './encryption.js';
import { KeyExchangeService } from './key-exchange.js';
import { Ed25519SigningService } from './signing.js';

export interface KeyProvider {
  getEncryptionKey(serviceId: string): Promise<EncryptionService | null>;
  getSigningKey(serviceId: string): Promise<Ed25519SigningService | null>;
  getKeyExchangeKey(serviceId: string): Promise<{ publicKey: Uint8Array; privateKey: CryptoKey } | null>;
  storeKeys(serviceId: string, keys: ServiceKeys): Promise<void>;
  rotateKeys(serviceId: string): Promise<ServiceKeys>;
  revokeKeys(serviceId: string): Promise<void>;
  getKeyVersion(serviceId: string): Promise<number>;
  // Retention hooks, used by the key rotation
  // manager to enforce the rotation policy.
  setRetentionPolicy?(policy: KeyRetentionPolicy): void;
  getEncryptionKeys?(serviceId: string): Promise<EncryptionService[]>;
}

// Bounded key-version retention: retired key
// versions remain usable for decryption during
// the grace period after rotation, and at most
// `maxVersions` retired versions are kept.
export interface KeyRetentionPolicy {
  gracePeriodMs: number;
  maxVersions: number;
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
  private history: Map<string, ServiceKeys[]> = new Map();
  private retention: KeyRetentionPolicy = {
    gracePeriodMs: 60 * 60 * 1000,
    maxVersions: 3,
  };
  private defaultTtlMs: number;

  constructor(defaultTtlMs = 24 * 60 * 60 * 1000, retention?: Partial<KeyRetentionPolicy>) {
    this.defaultTtlMs = defaultTtlMs;
    if (retention) {
      this.retention = { ...this.retention, ...retention };
    }
  }

  setRetentionPolicy(policy: KeyRetentionPolicy): void {
    this.retention = { ...policy };
  }

  async getEncryptionKey(serviceId: string): Promise<EncryptionService | null> {
    const keys = this.store.get(serviceId);
    if (!keys || this.isExpired(keys)) return null;
    return EncryptionService.create('aes-256-gcm', keys.encryptionKey);
  }

  // Current key first, then retained versions
  // still inside their grace period, so peers
  // can decrypt messages sent with a recently
  // rotated key.
  async getEncryptionKeys(serviceId: string): Promise<EncryptionService[]> {
    const keys: EncryptionService[] = [];

    const current = this.store.get(serviceId);
    if (current && !this.isExpired(current)) {
      keys.push(await EncryptionService.create('aes-256-gcm', current.encryptionKey));
    }

    for (const retired of this.history.get(serviceId) ?? []) {
      if (this.isExpired(retired)) continue;
      keys.push(await EncryptionService.create('aes-256-gcm', retired.encryptionKey));
    }

    return keys;
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

    // Retire the previous version: keep it
    // usable for decryption during the grace
    // period, bounded by maxVersions.
    if (oldKeys) {
      const retired: ServiceKeys = {
        ...oldKeys,
        expiresAt: issuedAt + this.retention.gracePeriodMs,
      };
      const versions = this.history.get(serviceId) ?? [];
      versions.unshift(retired);
      while (versions.length > this.retention.maxVersions) {
        versions.pop();
      }
      this.history.set(serviceId, versions);
    }

    await this.storeKeys(serviceId, newKeys);
    return newKeys;
  }

  async revokeKeys(serviceId: string): Promise<void> {
    this.store.delete(serviceId);
    this.history.delete(serviceId);
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

  setRetentionPolicy(policy: KeyRetentionPolicy): void {
    for (const provider of this.providers) {
      provider.setRetentionPolicy?.(policy);
    }
  }

  async getEncryptionKeys(serviceId: string): Promise<EncryptionService[]> {
    const keys: EncryptionService[] = [];
    for (const provider of this.providers) {
      if (provider.getEncryptionKeys) {
        keys.push(...(await provider.getEncryptionKeys(serviceId)));
      } else {
        const key = await provider.getEncryptionKey(serviceId);
        if (key) keys.push(key);
      }
    }
    return keys;
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