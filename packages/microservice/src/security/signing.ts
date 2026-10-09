import { KeyPair, KeyExchangeService } from './key-exchange.js';

export interface SigningService {
  sign(data: Uint8Array): Promise<Uint8Array>;
  verify(data: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

export class Ed25519SigningService implements SigningService {
  private keyPair: KeyPair;

  constructor(keyPair: KeyPair) {
    this.keyPair = keyPair;
  }

  static async create(keyPair?: KeyPair): Promise<Ed25519SigningService> {
    if (keyPair) {
      return new Ed25519SigningService(keyPair);
    }
    const newKeyPair = await KeyExchangeService.generateEd25519KeyPair();
    return new Ed25519SigningService(newKeyPair);
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(
      await crypto.subtle.sign('Ed25519', this.keyPair.privateKey, data as BufferSource)
    );
  }

  async verify(data: Uint8Array, signature: Uint8Array): Promise<boolean> {
    const publicKey = await crypto.subtle.importKey(
      'raw',
      this.keyPair.publicKey as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify']
    );

    return crypto.subtle.verify('Ed25519', publicKey, signature as BufferSource, data as BufferSource);
  }

  getPublicKey(): Uint8Array {
    return this.keyPair.publicKey;
  }
}

export class RsaSigningService implements SigningService {
  private keyPair: CryptoKeyPair;

  constructor(keyPair: CryptoKeyPair) {
    this.keyPair = keyPair;
  }

  static async create(keySize = 2048): Promise<RsaSigningService> {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: keySize,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify']
    );
    return new RsaSigningService(keyPair as CryptoKeyPair);
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(
      await crypto.subtle.sign('RSASSA-PKCS1-v1_5', this.keyPair.privateKey, data as BufferSource)
    );
  }

  async verify(data: Uint8Array, signature: Uint8Array): Promise<boolean> {
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', this.keyPair.publicKey, signature as BufferSource, data as BufferSource);
  }

  async getPublicKeyPem(): Promise<string> {
    const spki = await crypto.subtle.exportKey('spki', this.keyPair.publicKey);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
    return `-----BEGIN PUBLIC KEY-----\n${base64.match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----`;
  }
}