export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: CryptoKey;
}

export interface KeyExchangeResult {
  sharedSecret: Uint8Array;
  publicKey: Uint8Array;
}

/**
 * Interface for authenticated key exchange implementations.
 * 
 * X25519 provides key agreement but NOT peer authentication. An attacker who can
 * substitute public keys (MITM) can establish separate shared secrets with both
 * parties without detection.
 * 
 * Applications requiring authenticated key exchange MUST implement this interface
 * using an established protocol such as:
 * - Noise Protocol Framework (Noise_IK, Noise_XX, etc.)
 * - TLS 1.3 with certificate-based authentication
 * - SIGMA-based protocols with pre-shared keys or certificates
 * - PAKE protocols (e.g., OPAQUE)
 * 
 * @example
 * ```typescript
 * class NoiseIKExchange implements AuthenticatedKeyExchange {
 *   async authenticateAndDeriveKeys(
 *     staticKeyPair: KeyPair,
 *     peerStaticPublicKey: Uint8Array,
 *     prologue: Uint8Array
 *   ): Promise<AuthenticatedKeyExchangeResult> {
 *     // Implement Noise IK handshake
 *     // ...
 *   }
 * }
 * ```
 */
export interface AuthenticatedKeyExchange {
  /**
   * Perform authenticated key exchange and derive session keys.
   * 
   * @param staticKeyPair - Long-term identity key pair (Ed25519 for signing)
   * @param peerStaticPublicKey - Peer's verified long-term public key
   * @param prologue - Protocol-specific context binding (protocol name, versions, etc.)
   * @returns Authenticated session keys with peer identity bound to the exchange
   */
  authenticateAndDeriveKeys(
    staticKeyPair: KeyPair,
    peerStaticPublicKey: Uint8Array,
    prologue: Uint8Array
  ): Promise<AuthenticatedKeyExchangeResult>;
}

/**
 * Result of an authenticated key exchange.
 * 
 * Unlike the unauthenticated KeyExchangeResult, this includes:
 * - Verified peer identity (bound to the static public key)
 * - Transcript hash for channel binding
 * - Explicit key separation for each cryptographic purpose
 */
export interface AuthenticatedKeyExchangeResult {
  /** Derived encryption key (non-extractable CryptoKey) */
  encryptionKey: CryptoKey;
  /** Derived signing/authentication key (non-extractable CryptoKey) */
  signingKey: CryptoKey;
  /** Derived key for additional authentication (non-extractable CryptoKey) */
  authKey: CryptoKey;
  /** Peer's verified static public key */
  peerStaticPublicKey: Uint8Array;
  /** Handshake transcript hash for channel binding */
  transcriptHash: Uint8Array;
  /** Protocol identifier for version negotiation */
  protocol: string;
}

/**
 * KeyExchangeService provides low-level cryptographic primitives for key agreement.
 * 
 * ⚠️ SECURITY WARNING: The X25519 key agreement methods in this class (computeSharedSecret,
 * deriveSessionKeys) provide key agreement ONLY. They do NOT authenticate the peer.
 * 
 * An active network attacker (MITM) can:
 * 1. Intercept and replace public keys in transit
 * 2. Establish independent shared secrets with each party
 * 3. Decrypt, modify, and re-encrypt all communications
 * 
 * To establish an authenticated session, you MUST use one of:
 * - Transport-layer security (TLS 1.3, mTLS) with verified certificates
 * - An authenticated key exchange protocol (Noise, SIGMA, PAKE) implemented via AuthenticatedKeyExchange
 * - Pre-shared key authentication with out-of-band key distribution
 * 
 * The low-level X25519 primitives are provided for:
 * - Building custom authenticated protocols
 * - Scenarios where authentication is provided by an outer layer (e.g., TLS)
 * - Testing and development
 * 
 * @example
 * ```typescript
 * // UNSAFE - No peer authentication!
 * const aliceKeys = await KeyExchangeService.generateX25519KeyPair();
 * const bobKeys = await KeyExchangeService.generateX25519KeyPair();
 * const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
 *   aliceKeys.privateKey, bobKeys.publicKey, aliceKeys.publicKey
 * );
 * 
 * // SAFE - Use authenticated exchange
 * const noiseExchange = new NoiseIKExchange();
 * const result = await noiseExchange.authenticateAndDeriveKeys(
 *   aliceStaticKeys, bobStaticPublicKey, new TextEncoder().encode('my-protocol/v1')
 * );
 * // result.peerStaticPublicKey is verified to belong to Bob
 * ```
 */
export class KeyExchangeService {
  static async generateX25519KeyPair(): Promise<KeyPair> {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'X25519' },
      true,
      ['deriveBits', 'deriveKey']
    ) as CryptoKeyPair;

    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
    
    return { publicKey, privateKey: keyPair.privateKey };
  }

  static async generateEd25519KeyPair(): Promise<KeyPair> {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,
      ['sign', 'verify']
    ) as CryptoKeyPair;

    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
    
    return { publicKey, privateKey: keyPair.privateKey };
  }

  /**
   * Compute X25519 shared secret (UNAUTHENTICATED).
   * 
   * ⚠️ SECURITY WARNING: This method performs raw X25519 key agreement WITHOUT
   * peer authentication. The resulting shared secret is only as trustworthy as
   * the channel used to exchange public keys.
   * 
   * An attacker who can substitute the peerPublicKey parameter can compute the
   * same shared secret. This method MUST NOT be used directly for establishing
   * secure sessions without an outer authentication layer.
   * 
   * @param privateKey - Local X25519 private key
   * @param peerPublicKey - Peer's X25519 public key (MUST be authenticated out-of-band)
   * @param ownPublicKey - Local X25519 public key (for reference)
   * @returns Shared secret and own public key
   * 
   * @example
   * ```typescript
   * // ONLY safe if peerPublicKey is authenticated via TLS, certificates, or pre-shared knowledge
   * const { sharedSecret } = await KeyExchangeService.computeSharedSecret(
   *   myPrivateKey,
   *   authenticatedPeerPublicKey, // Verified via certificate, TOFU, etc.
   *   myPublicKey
   * );
   * ```
   */
  static async computeSharedSecret(
    privateKey: CryptoKey,
    peerPublicKey: Uint8Array,
    ownPublicKey: Uint8Array
  ): Promise<KeyExchangeResult> {
    const peerKey = await crypto.subtle.importKey(
      'raw',
      peerPublicKey as BufferSource,
      { name: 'X25519' },
      false,
      []
    );

    const sharedSecret = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'X25519', public: peerKey },
        privateKey,
        256
      )
    );

    return { sharedSecret, publicKey: ownPublicKey };
  }

/**
   * Derive session keys from a shared secret (UNAUTHENTICATED).
   * 
   * ⚠️ SECURITY WARNING: The security of the derived keys depends entirely on
   * the authenticity of the shared secret. If the shared secret was computed
   * via unauthenticated X25519 (computeSharedSecret), a MITM attacker can derive
   * identical keys.
   * 
   * The returned keys are extractable (can be exported as raw bytes) for
   * compatibility with existing APIs. For stronger key isolation, use
   * `deriveSessionKeysNonExtractable()` which returns non-extractable CryptoKey objects.
   * 
   * @param sharedSecret - 32-byte X25519 shared secret (MUST be from authenticated exchange)
   * @param salt - Random salt (recommended 32 bytes, unique per session)
   * @param info - Context-specific info for key separation (protocol, session ID, etc.)
   * @returns Extractable key material for encryption, signing, and authentication
   * 
   * @example
   * ```typescript
   * // ONLY safe if sharedSecret is from authenticated exchange
   * const keys = await KeyExchangeService.deriveSessionKeys(
   *   authenticatedSharedSecret,
   *   crypto.getRandomValues(new Uint8Array(32)),
   *   new TextEncoder().encode('my-protocol/session-123')
   * );
   * ```
   */
  static async deriveSessionKeys(
    sharedSecret: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array
  ): Promise<{
    encryptionKey: Uint8Array;
    signingKey: Uint8Array;
    authKey: Uint8Array;
  }> {
    // Validate inputs
    if (!sharedSecret || sharedSecret.length === 0) {
      throw new Error('Shared secret cannot be empty');
    }
    if (sharedSecret.length !== 32) {
      throw new Error('Shared secret must be 32 bytes');
    }
    if (!salt || salt.length === 0) {
      throw new Error('Salt cannot be empty');
    }

    const baseKey = await crypto.subtle.importKey(
      'raw',
      sharedSecret as BufferSource,
      { name: 'HKDF' },
      false,
      ['deriveKey']
    );

    const encryptionKey = new Uint8Array(
      await crypto.subtle.exportKey('raw',
        await crypto.subtle.deriveKey(
          { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: new Uint8Array([...info, 0x01]) },
          baseKey,
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt']
        )
      )
    );

    const signingKey = new Uint8Array(
      await crypto.subtle.exportKey('raw',
        await crypto.subtle.deriveKey(
          { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: new Uint8Array([...info, 0x02]) },
          baseKey,
          { name: 'HMAC', hash: 'SHA-256', length: 256 },
          true,
          ['sign', 'verify']
        )
      )
    );

    const authKey = new Uint8Array(
      await crypto.subtle.exportKey('raw',
        await crypto.subtle.deriveKey(
          { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: new Uint8Array([...info, 0x03]) },
          baseKey,
          { name: 'HMAC', hash: 'SHA-256', length: 256 },
          true,
          ['sign', 'verify']
        )
      )
    );

    return {
      encryptionKey: new Uint8Array(encryptionKey),
      signingKey: new Uint8Array(signingKey),
      authKey: new Uint8Array(authKey),
    };
  }

  /**
   * Derive session keys as non-extractable CryptoKey objects.
   * 
   * This method provides stronger key isolation by returning CryptoKey objects
   * that cannot be exported as raw bytes. Use this method when you can work
   * directly with CryptoKey objects and don't need to serialize the keys.
   * 
   * @param sharedSecret - 32-byte X25519 shared secret
   * @param salt - Random salt (recommended 32 bytes)
   * @param info - Context-specific info for key separation
   * @returns Object containing non-extractable CryptoKey objects for encryption, signing, and auth
   */
  static async deriveSessionKeysNonExtractable(
    sharedSecret: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array
  ): Promise<{
    encryptionKey: CryptoKey;
    signingKey: CryptoKey;
    authKey: CryptoKey;
  }> {
    // Validate inputs
    if (!sharedSecret || sharedSecret.length === 0) {
      throw new Error('Shared secret cannot be empty');
    }
    if (sharedSecret.length !== 32) {
      throw new Error('Shared secret must be 32 bytes');
    }
    if (!salt || salt.length === 0) {
      throw new Error('Salt cannot be empty');
    }

    const baseKey = await crypto.subtle.importKey(
      'raw',
      sharedSecret as BufferSource,
      { name: 'HKDF' },
      false,
      ['deriveKey']
    );

    const encryptionKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: new Uint8Array([...info, 0x01]) },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false, // Non-extractable
      ['encrypt', 'decrypt']
    );

    const signingKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: new Uint8Array([...info, 0x02]) },
      baseKey,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false, // Non-extractable
      ['sign', 'verify']
    );

    const authKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: new Uint8Array([...info, 0x03]) },
      baseKey,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false, // Non-extractable
      ['sign', 'verify']
    );

    return {
      encryptionKey,
      signingKey,
      authKey,
    };
  }
}