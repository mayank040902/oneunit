import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EncryptedEnvelope, MessageEnvelope } from '../contracts/messages.js';
import { z } from 'zod';

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

const encryptedEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  cipherSuite: z.enum(['aes-256-gcm', 'chacha20-poly1305']),
  keyId: z.string().min(1).max(256),
  nonce: z.instanceof(Uint8Array).refine(
    (value) => value.length === 12,
    'nonce must be 12 bytes',
  ),
  ciphertext: z.instanceof(Uint8Array).refine(
    (value) => value.length <= MAX_ENCRYPTION_INPUT_BYTES,
    'ciphertext exceeds maximum size',
  ),
  tag: z.instanceof(Uint8Array).refine(
    (value) => value.length === 16,
    'tag must be 16 bytes',
  ),
  authenticatedMetadata: z.instanceof(Uint8Array).refine(
    (value) => value.length <= MAX_AUTHENTICATED_METADATA_BYTES,
    'authenticated metadata exceeds maximum size',
  ),
  signature: z.instanceof(Uint8Array).optional(),
});

const authenticatedMetadataSchema = z.strictObject({
  version: z.literal(1),
  messageId: z.string().min(1),
  type: z.string().min(1),
  schemaVersion: z.number().int().nonnegative(),
  source: z.strictObject({
    serviceId: z.string().min(1),
    instanceId: z.string().min(1),
  }),
  destination: z.strictObject({
    serviceId: z.string().min(1),
  }).optional(),
  timestamp: z.number().finite(),
  correlationId: z.string().min(1).optional(),
  traceContext: z.record(z.string()).optional(),
});

export const MAX_ENCRYPTION_INPUT_BYTES = 16 * 1024 * 1024;
export const MAX_AUTHENTICATED_METADATA_BYTES = 1 * 1024 * 1024;


function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function isEncryptionAlgorithmId(value: unknown): value is EncryptionAlgorithmId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SUPPORTED_ALGORITHMS, value);
}

export function buildEnvelopeSignatureData(
  encrypted: EncryptedEnvelope,
  signatureAlgorithm: string = 'envelope-signature'
): Uint8Array {
  const parts: Uint8Array[] = [];
  const text = new TextEncoder();
  const pushText = (value: string) => {
    const bytes = text.encode(value);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, bytes.length, false);
    parts.push(len, bytes);
  };
  const pushBytes = (value: Uint8Array) => {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, value.length, false);
    parts.push(len, value);
  };

  pushText('oneunit-microservice-envelope-signature-v1');
  pushText(signatureAlgorithm);
  pushText(encrypted.cipherSuite);
  pushText(encrypted.keyId);
  pushBytes(encrypted.nonce);
  pushBytes(encrypted.ciphertext);
  pushBytes(encrypted.tag);
  pushBytes(encrypted.authenticatedMetadata);

  let total = 0;
  for (const part of parts) total += part.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
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
    if (!isEncryptionAlgorithmId(algorithm)) {
      throw new Error(`Unsupported algorithm: ${algorithm}`);
    }
    if (!isUint8Array(keyMaterial)) {
      throw new Error('keyMaterial must be a Uint8Array');
    }
    if (keyMaterial.length === 0) {
      throw new Error('keyMaterial must not be empty');
    }
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

    if (keyMaterial.length !== algo.keyLength) {
      throw new Error(
        `aes-256-gcm requires a ${algo.keyLength * 8}-bit (${algo.keyLength}-byte) key`,
      );
    }

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyMaterial as BufferSource,
      { name: algo.name },
      false,
      ['encrypt', 'decrypt']
    );

    return new EncryptionService(cryptoKey, algo, new Uint8Array(0), algorithm);
  }

  static async generateKey(algorithm: 'aes-256-gcm' | 'chacha20-poly1305'): Promise<Uint8Array> {
    if (!isEncryptionAlgorithmId(algorithm)) {
      throw new Error(`Unsupported algorithm: ${algorithm}`);
    }
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
    if (!isUint8Array(plaintext)) {
      throw new Error('plaintext must be a Uint8Array');
    }
    if (plaintext.length > MAX_ENCRYPTION_INPUT_BYTES) {
      throw new Error(`plaintext exceeds maximum size of ${MAX_ENCRYPTION_INPUT_BYTES} bytes`);
    }
    if (associatedData !== undefined) {
      if (!isUint8Array(associatedData)) {
        throw new Error('associatedData must be a Uint8Array');
      }
      if (associatedData.length > MAX_AUTHENTICATED_METADATA_BYTES) {
        throw new Error(
          `associatedData exceeds maximum size of ${MAX_AUTHENTICATED_METADATA_BYTES} bytes`,
        );
      }
    }

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
    if (!input || typeof input !== 'object') {
      throw new Error('Decryption input must be an object');
    }
    if (!isUint8Array(input.ciphertext)) {
      throw new Error('ciphertext must be a Uint8Array');
    }
    if (!isUint8Array(input.nonce)) {
      throw new Error('nonce must be a Uint8Array');
    }
    if (!isUint8Array(input.tag)) {
      throw new Error('tag must be a Uint8Array');
    }
    if (input.nonce.length !== this.algorithm.nonceLength) {
      throw new Error(`nonce must be ${this.algorithm.nonceLength} bytes`);
    }
    if (input.tag.length !== this.algorithm.tagLength) {
      throw new Error(`tag must be ${this.algorithm.tagLength} bytes`);
    }
    if (input.ciphertext.length > MAX_ENCRYPTION_INPUT_BYTES) {
      throw new Error(`ciphertext exceeds maximum size of ${MAX_ENCRYPTION_INPUT_BYTES} bytes`);
    }
    if (input.associatedData !== undefined) {
      if (!isUint8Array(input.associatedData)) {
        throw new Error('associatedData must be a Uint8Array');
      }
      if (input.associatedData.length > MAX_AUTHENTICATED_METADATA_BYTES) {
        throw new Error(
          `associatedData exceeds maximum size of ${MAX_AUTHENTICATED_METADATA_BYTES} bytes`,
        );
      }
    }

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
      try {
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(input.ciphertext)),
          decipher.final(),
        ]);
        return new Uint8Array(plaintext);
      } catch {
        throw new Error('Decryption failed');
      }
    }

    const combined = new Uint8Array(input.ciphertext.length + input.tag.length);
    combined.set(input.ciphertext, 0);
    combined.set(input.tag, input.ciphertext.length);

    const algorithmParams: AesGcmParams = {
      name: this.algorithm.name,
      iv: input.nonce as BufferSource,
      tagLength: this.algorithm.tagLength * 8,
    };
    if (input.associatedData) {
      algorithmParams.additionalData = input.associatedData as BufferSource;
    }

    try {
      const decrypted = await crypto.subtle.decrypt(
        algorithmParams,
        this.cryptoKey as CryptoKey,
        combined as BufferSource
      );
      return new Uint8Array(decrypted);
    } catch {
      throw new Error('Decryption failed');
    }
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
    options?: {
      keyId?: string;
      signer?: unknown;
      signingService?: unknown;
      signingKey?: unknown;
      signatureAlgorithm?: string;
    }
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

    const encrypted: EncryptedEnvelope = {
      version: 1,
      cipherSuite: this.algorithmId,
      keyId: options?.keyId ?? 'default',
      nonce,
      ciphertext,
      tag,
      authenticatedMetadata,
    };

    const signerCandidate =
      (options as { signer?: unknown } | undefined)?.signer ??
      (options as { signingService?: unknown } | undefined)?.signingService ??
      (options as { signingKey?: unknown } | undefined)?.signingKey;
    const signer =
      signerCandidate && typeof signerCandidate === 'object' && typeof (signerCandidate as { sign?: unknown }).sign === 'function'
        ? (signerCandidate as { sign: (data: Uint8Array) => Promise<Uint8Array> | Uint8Array })
        : undefined;
    if (signer) {
      const data = buildEnvelopeSignatureData(encrypted, 'envelope-signature');
      const signature = await signer.sign(data);
      encrypted.signature = new Uint8Array(signature);
    }

    return encrypted;
  }

  // Verify the authenticated metadata and recover the
  // original message envelope. Throws when the tag or
  // the metadata authentication fails.
  async decryptEnvelope<TPayload = unknown>(
    encrypted: EncryptedEnvelope,
    payloadSchema?: z.ZodType<TPayload>,
    options?: {
      requireSignature?: boolean;
      signatureRequired?: boolean;
      signaturePolicy?: 'none' | 'optional' | 'required';
      verifier?: unknown;
      signatureVerifier?: unknown;
      signingService?: unknown;
      signingKey?: unknown;
      verificationService?: unknown;
      verifySignature?: unknown;
      expectedKeyId?: string;
      keyId?: string;
      encryptionKeyId?: string;
      signatureAlgorithm?: string;
    }
  ): Promise<MessageEnvelope<TPayload>> {
    const resolvedPayloadSchema = payloadSchema ?? (z.unknown() as z.ZodType<TPayload>);

    if (!encrypted || typeof encrypted !== 'object') {
      throw new Error('Invalid encrypted envelope');
    }

    if (
      !encrypted ||
      typeof encrypted !== 'object' ||
      typeof (encrypted as { version?: unknown }).version !== 'number' ||
      (encrypted as { version: number }).version !== 1
    ) {
      throw new Error(`Unsupported encrypted envelope version: ${(encrypted as { version?: unknown })?.version}`);
    }

    const envelopeResult = encryptedEnvelopeSchema.safeParse(encrypted);
    if (!envelopeResult.success) {
      throw new Error('Invalid encrypted envelope');
    }
    const data = envelopeResult.data;

    if (data.cipherSuite !== this.algorithmId) {
      throw new Error(
        `Cipher suite mismatch: envelope requires ${data.cipherSuite}, service uses ${this.algorithmId}`
      );
    }

    const normalizedOptions = options ?? {};
    const signaturePolicy =
      normalizedOptions.signaturePolicy ??
      (normalizedOptions.requireSignature === true || normalizedOptions.signatureRequired === true
        ? 'required'
        : (encrypted.signature ? 'optional' : 'none'));

    if (normalizedOptions.expectedKeyId || normalizedOptions.keyId || normalizedOptions.encryptionKeyId) {
      const expected = normalizedOptions.expectedKeyId ?? normalizedOptions.keyId ?? normalizedOptions.encryptionKeyId;
      if (expected !== undefined && encrypted.keyId !== expected) {
        throw new Error('Encryption key identifier mismatch');
      }
    }

    const verifierCandidate =
      normalizedOptions.verifier ??
      normalizedOptions.signatureVerifier ??
      normalizedOptions.signingService ??
      normalizedOptions.signingKey ??
      normalizedOptions.verificationService ??
      normalizedOptions.verifySignature;
    const verifySignature =
      typeof verifierCandidate === 'function'
        ? (data: Uint8Array, signature: Uint8Array) => Promise.resolve(verifierCandidate(data, signature))
        : verifierCandidate &&
          typeof verifierCandidate === 'object' &&
          typeof (verifierCandidate as { verify?: unknown }).verify === 'function'
        ? (data: Uint8Array, signature: Uint8Array) =>
            Promise.resolve((verifierCandidate as { verify: (data: Uint8Array, signature: Uint8Array) => unknown }).verify(data, signature))
        : undefined;

    if (encrypted.signature || signaturePolicy !== 'none') {
      if (!encrypted.signature) {
        if (signaturePolicy === 'required') {
          throw new Error('Envelope signature is required');
        }
      } else {
        if (!verifySignature) {
          throw new Error('Envelope signature verification is unavailable');
        }
        const signatureAlgorithm = normalizedOptions.signatureAlgorithm ?? 'envelope-signature';
        const data = buildEnvelopeSignatureData(encrypted, signatureAlgorithm);
        const valid = await verifySignature(data, encrypted.signature);
        if (valid !== true) {
          throw new Error('Envelope signature verification failed');
        }
      }
    }

    let plaintext: Uint8Array;
    try {
      plaintext = await this.decrypt({
        ciphertext: data.ciphertext,
        nonce: data.nonce,
        tag: data.tag,
        associatedData: data.authenticatedMetadata,
      });
    } catch {
      throw new Error('Decryption failed');
    }

    let metadata: z.infer<typeof authenticatedMetadataSchema>;
    try {
      metadata = authenticatedMetadataSchema.parse(
        JSON.parse(new TextDecoder().decode(data.authenticatedMetadata))
      );
    } catch {
      throw new Error('Invalid authenticated envelope metadata');
    }

    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
      throw new Error('Invalid JSON payload');
    }

    const payloadResult = resolvedPayloadSchema.safeParse(parsedPayload);
    if (!payloadResult.success) {
      throw new Error('Payload validation failed');
    }

    return {
      version: metadata.version as 1,
      messageId: metadata.messageId,
      type: metadata.type,
      schemaVersion: metadata.schemaVersion,
      source: metadata.source,
      destination: metadata.destination,
      timestamp: metadata.timestamp,
      correlationId: metadata.correlationId,
      traceContext: metadata.traceContext,
      payload: payloadResult.data as TPayload,
    };
  }
}


export async function deriveKey(
  algorithm: 'aes-256-gcm' | 'chacha20-poly1305',
  password: string | Uint8Array,
  salt: Uint8Array,
  iterations = 100000
): Promise<Uint8Array> {
  if (!isEncryptionAlgorithmId(algorithm)) {
    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }
  const algo = SUPPORTED_ALGORITHMS[algorithm];
  if (!algo) {
    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }
  if (!isUint8Array(salt)) {
    throw new Error('salt must be a Uint8Array');
  }
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error('iterations must be a positive integer');
  }
  if (iterations > 10000000) {
    throw new Error('iterations exceed maximum');
  }
  if (typeof password !== 'string' && !isUint8Array(password)) {
    throw new Error('password must be a string or Uint8Array');
  }

  const passwordBytes =
    typeof password === 'string' ? new TextEncoder().encode(password) : password;

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordBytes as BufferSource,
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
