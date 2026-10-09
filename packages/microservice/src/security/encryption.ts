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
  private algorithm: EncryptionAlgorithm;
  private key: CryptoKey;

  constructor(key: CryptoKey, algorithm: EncryptionAlgorithm) {
    this.key = key;
    this.algorithm = algorithm;
  }

  static async create(
    algorithm: 'aes-256-gcm' | 'chacha20-poly1305',
    keyMaterial: Uint8Array
  ): Promise<EncryptionService> {
    const algo = SUPPORTED_ALGORITHMS[algorithm];
    if (!algo) {
      throw new Error(`Unsupported algorithm: ${algorithm}`);
    }

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyMaterial as BufferSource,
      { name: algo.name },
      false,
      ['encrypt', 'decrypt']
    );

    return new EncryptionService(cryptoKey, algo);
  }

  static async generateKey(algorithm: 'aes-256-gcm' | 'chacha20-poly1305'): Promise<Uint8Array> {
    const algo = SUPPORTED_ALGORITHMS[algorithm];
    if (!algo) {
      throw new Error(`Unsupported algorithm: ${algorithm}`);
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
    
    const algorithmParams: AesGcmParams = { name: this.algorithm.name, iv: nonce };
    if (associatedData) {
      algorithmParams.additionalData = associatedData as BufferSource;
    }
    
    const encrypted = await crypto.subtle.encrypt(
      algorithmParams,
      this.key,
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

    const algorithmParams: AesGcmParams = { name: this.algorithm.name, iv: input.nonce as BufferSource, tagLength: this.algorithm.tagLength * 8 };
    if (input.associatedData) {
      algorithmParams.additionalData = input.associatedData as BufferSource;
    }

    const decrypted = await crypto.subtle.decrypt(
      algorithmParams,
      this.key,
      combined as BufferSource
    );

    return new Uint8Array(decrypted);
  }

  getAlgorithm(): EncryptionAlgorithm {
    return this.algorithm;
  }

  getKey(): CryptoKey {
    return this.key;
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