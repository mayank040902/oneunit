import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EncryptedEnvelope, MessageEnvelope } from '../contracts/messages.js';

export type EncryptionAlgorithmId = 'aes-256-gcm' | 'chacha20-poly1305';

export interface EncryptionAlgorithm {
  name: string;
  keyLength: number;
  nonceLength: number;
  tagLength: number;
}

export const SUPPORTED_ALGORITHMS: Record<string, EncryptionAlgorithm> = {
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
};

export interface EncryptionResult {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  tag: Uint8Array;
}

export interface DecryptionInput {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  tag: Uint8Array;
  associatedData?: Uint8Array;
}

export class EncryptionService {
  private cryptoKey: CryptoKey | null;
  private rawKey: Uint8Array;
  private algorithm: EncryptionAlgorithm;
  private algorithmId: EncryptionAlgorithmId;

  constructor(cryptoKey: CryptoKey | null, algorithm: EncryptionAlgorithm, rawKey: Uint8Array, algorithmId: EncryptionAlgorithmId) {
    this.cryptoKey = cryptoKey;
    this.algorithm = algorithm;
    this.rawKey = rawKey;
    this.algorithmId = algorithmId;
  }

  static async create(
    algorithm: 'aes-256-gcm' | 'chacha20-poly1305',
    keyMaterial: Uint8Array
  ): Promise<EncryptionService> {
    const algo = SUPPORTED_ALGORITHMS[algorithm];
    if (!algo) {
      throw new Error(`Unsupported algorithm: ${algorithm}`);
    }

    if (algorithm === 'chacha20-poly1305') {
      // Web Crypto cannot import raw ChaCha20-Poly1305
      // keys ("Unable to import ChaCha20-Poly1305 using
      // raw format"), so the algorithm is implemented with
      // the stable node:crypto primitives instead.
      if (keyMaterial.length !== algo.keyLength) {
        throw new Error(
          `chacha20-poly1305 requires a ${algo.keyLength * 8}-bit (${algo.keyLength}-byte) key`,
        );
      }
      const rawKey = new Uint8Array(keyMaterial);
      return new EncryptionService(null, algo, rawKey, algorithm);
    }

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyMaterial as BufferSource,
      { name: algo.name },
      false,
      ['encrypt', 'decrypt']
    );

    return new EncryptionService(cryptoKey, algo, new Uint8Array(keyMaterial), algorithm);
  }

  static async generateKey(algorithm: 'aes-256-gcm' | 'chacha20-poly1305'): Promise<Uint8Array> {
    const algo = SUPPORTED_ALGORITHMS[algorithm];
    if (!algo) {
      throw new Error(`Unsupported algorithm: ${algorithm}`);
    }

    if (algorithm === 'chacha20-poly1305') {
      // node:crypto key generation works on every
      // supported Node version; Web Crypto key
      // generation for ChaCha20-Poly1305 is
      // experimental and cannot be imported raw.
      return new Uint8Array(randomBytes(algo.keyLength));
    }

    const key = await crypto.subtle.generateKey(
      { name: algo.name, length: algo.keyLength * 8 },
      true,
      ['encrypt', 'decrypt']
    );

    return new Uint8Array(await crypto.subtle.exportKey('raw', key));
  }

  async encrypt(plaintext: Uint8Array, associatedData?: Uint8Array): Promise<EncryptionResult> {
    const nonce = crypto.getRandomValues(new Uint8Array(this.algorithm.nonceLength));

    if (this.algorithm.name === 'CHACHA20-POLY1305') {
      const cipher = createCipheriv(
        'chacha20-poly1305',
        Buffer.from(this.rawKey),
        Buffer.from(nonce),
      );
      if (associatedData) {
        cipher.setAAD(Buffer.from(associatedData), {
          plaintextLength: plaintext.length,
        });
      }
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(plaintext)),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return {
        ciphertext: new Uint8Array(ciphertext),
        nonce,
        tag: new Uint8Array(tag),
      };
    }

    const algorithmParams: AesGcmParams = { name: this.algorithm.name, iv: nonce };
    if (associatedData) {
      algorithmParams.additionalData = associatedData as BufferSource;
    }

    const encrypted = await crypto.subtle.encrypt(
      algorithmParams,
      this.cryptoKey as CryptoKey,
      plaintext as BufferSource
    );

    const encryptedArray = new Uint8Array(encrypted);
    const tag = encryptedArray.slice(-this.algorithm.tagLength);
    const ciphertext = encryptedArray.slice(0, -this.algorithm.tagLength);

    return { ciphertext, nonce, tag };
  }

  async decrypt(input: DecryptionInput): Promise<Uint8Array> {
    const combined = new Uint8Array(input.ciphertext.length + input.tag.length);
    combined.set(input.ciphertext, 0);
    combined.set(input.tag, input.ciphertext.length);

    if (this.algorithm.name === 'CHACHA20-POLY1305') {
      const decipher = createDecipheriv(
        'chacha20-poly1305',
        Buffer.from(this.rawKey),
        Buffer.from(input.nonce),
      );
      if (input.associatedData) {
        decipher.setAAD(Buffer.from(input.associatedData), {
          plaintextLength: input.ciphertext.length,
        });
      }
      decipher.setAuthTag(Buffer.from(input.tag));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(input.ciphertext)),
        decipher.final(),
      ]);
      return new Uint8Array(plaintext);
    }

    const algorithmParams: AesGcmParams = { name: this.algorithm.name, iv: input.nonce as BufferSource, tagLength: this.algorithm.tagLength * 8 };
    if (input.associatedData) {
      algorithmParams.additionalData = input.associatedData as BufferSource;
    }

    const decrypted = await crypto.subtle.decrypt(
      algorithmParams,
      this.cryptoKey as CryptoKey,
      combined as BufferSource
    );

    return new Uint8Array(decrypted);
  }

  getAlgorithm(): EncryptionAlgorithm {
    return this.algorithm;
  }

  getKey(): CryptoKey | null {
    // Web Crypto keys exist only for AES-GCM;
    // ChaCha20-Poly1305 is implemented with
    // node:crypto and exposes no CryptoKey.
    return this.cryptoKey;
  }

  // Produce the standard encrypted wire contract
  // (§contracts/messages.ts EncryptedEnvelope) from a
  // message envelope. The payload is encrypted and the
  // envelope metadata is canonicalized and authenticated
  // as associated data, so routing fields cannot be
  // modified without failing authentication.
  async encryptEnvelope<TPayload>(
    envelope: MessageEnvelope<TPayload>,
    options?: { keyId?: string }
  ): Promise<EncryptedEnvelope> {
    const payloadBytes = new TextEncoder().encode(JSON.stringify(envelope.payload));
    const authenticatedMetadata = new TextEncoder().encode(
      JSON.stringify({
        version: envelope.version,
        messageId: envelope.messageId,
        type: envelope.type,
        schemaVersion: envelope.schemaVersion,
        source: envelope.source,
        destination: envelope.destination,
        timestamp: envelope.timestamp,
        correlationId: envelope.correlationId,
        traceContext: envelope.traceContext,
      })
    );

    const { ciphertext, nonce, tag } = await this.encrypt(payloadBytes, authenticatedMetadata);

    return {
      version: 1,
      cipherSuite: this.algorithmId,
      keyId: options?.keyId ?? 'default',
      nonce,
      ciphertext,
      tag,
      authenticatedMetadata,
    };
  }

  // Verify the authenticated metadata and recover the
  // original message envelope. Throws when the tag or
  // the metadata authentication fails.
  async decryptEnvelope<TPayload = unknown>(
    encrypted: EncryptedEnvelope
  ): Promise<MessageEnvelope<TPayload>> {
    if (encrypted.version !== 1) {
      throw new Error(`Unsupported encrypted envelope version: ${encrypted.version}`);
    }
    if (encrypted.cipherSuite !== this.algorithmId) {
      throw new Error(
        `Cipher suite mismatch: envelope requires ${encrypted.cipherSuite}, service uses ${this.algorithmId}`
      );
    }

    const plaintext = await this.decrypt({
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      tag: encrypted.tag,
      associatedData: encrypted.authenticatedMetadata,
    });

    const metadata = JSON.parse(new TextDecoder().decode(encrypted.authenticatedMetadata));
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as TPayload;

    return {
      version: metadata.version,
      messageId: metadata.messageId,
      type: metadata.type,
      schemaVersion: metadata.schemaVersion,
      source: metadata.source,
      destination: metadata.destination,
      timestamp: metadata.timestamp,
      correlationId: metadata.correlationId,
      traceContext: metadata.traceContext,
      payload,
    };
  }
}

export async function deriveKey(
  algorithm: 'aes-256-gcm' | 'chacha20-poly1305',
  password: string,
  salt: Uint8Array,
  iterations = 100000
): Promise<Uint8Array> {
  const algo = SUPPORTED_ALGORITHMS[algorithm];
  if (!algo) {
    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    algo.keyLength * 8
  );

  return new Uint8Array(derived);
}
