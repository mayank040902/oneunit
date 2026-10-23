import { X509Certificate, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { ServiceIdentity } from './service-identity.js';
import { ServiceCredentials } from './credentials.js';
import type { ServiceRegistration } from '../contracts/schemas.js';

export interface AuthenticationResult {
  authenticated: boolean;
  identity?: ServiceIdentity;
  error?: string;
}

export interface Authenticator {
  authenticate(credentials: ServiceCredentials): Promise<AuthenticationResult>;
  validateIdentity(identity: ServiceIdentity): Promise<boolean>;
}

export class X509Authenticator implements Authenticator {
  private trustedCAs: string[] = [];

  constructor(trustedCAs: string[] = []) {
    this.trustedCAs = trustedCAs;
  }

  addTrustedCA(ca: string): void {
    this.trustedCAs.push(ca);
  }

  async authenticate(credentials: ServiceCredentials): Promise<AuthenticationResult> {
    if (credentials.type !== 'x509' && credentials.type !== 'mtls') {
      return { authenticated: false, error: 'Invalid credential type for X509 authenticator' };
    }

    if (!credentials.certificate) {
      return { authenticated: false, error: 'Missing certificate' };
    }

    try {
      const cert = await this.parseCertificate(credentials.certificate);
      
      if (this.isExpired(cert)) {
        return { authenticated: false, error: 'Certificate expired' };
      }

      if (this.trustedCAs.length === 0) {
        return { authenticated: false, error: 'No trusted CAs configured' };
      }

      if (this.isNotYetValid(cert)) {
        return { authenticated: false, error: 'Certificate not yet valid' };
      }

      const trusted = await this.verifyChain(cert);
      if (!trusted) {
        return { authenticated: false, error: 'Certificate not trusted' };
      }

      const identity = this.extractIdentity(cert);
      
      return {
        authenticated: true,
        identity: {
          serviceId: identity.serviceId,
          serviceName: identity.serviceName,
          instanceId: identity.instanceId,
          credentials,
          getRegistration: () => { throw new Error('NotSupportedError: getRegistration is not supported by authenticator identity'); },
          sign: async () => { throw new Error('NotSupportedError: signing is not supported by authenticator identity'); },
          verify: async () => { throw new Error('NotSupportedError: verification is not supported by authenticator identity'); },
        },
      };
    } catch (err) {
      return { authenticated: false, error: (err as Error).message };
    }
  }

  async validateIdentity(identity: ServiceIdentity): Promise<boolean> {
    if (!identity.credentials.certificate) {
      return false;
    }

    try {
      const cert = await this.parseCertificate(identity.credentials.certificate);
      return !this.isExpired(cert);
    } catch {
      return false;
    }
  }

  private async parseCertificate(pem: string): Promise<X509Certificate> {
    const { X509Certificate } = await import('crypto');
    return new X509Certificate(pem);
  }

  private isExpired(cert: X509Certificate): boolean {
    return Date.now() > new Date(cert.validTo).getTime();
  }

  private isNotYetValid(cert: X509Certificate): boolean {
    return Date.now() < new Date(cert.validFrom).getTime();
  }

  private async verifyChain(cert: X509Certificate): Promise<boolean> {
    for (const caPem of this.trustedCAs) {
      try {
        const ca = await this.parseCertificate(caPem);
        if (ca.subject !== cert.issuer) continue;
        if (Date.now() > new Date(ca.validTo).getTime()) continue;
        if (Date.now() < new Date(ca.validFrom).getTime()) continue;
        const verified = cert.verify(ca.publicKey);
        if (verified) return true;
      } catch {
        continue;
      }
    }
    return false;
  }

private extractIdentity(cert: X509Certificate): { serviceId: string; serviceName: string; instanceId: string } {
    const subject = cert.subject;
    const serviceIdMatch = subject.match(/CN=([^,]+)/);
    const serviceId = serviceIdMatch?.[1] ?? 'unknown';

    return {
      serviceId,
      serviceName: serviceId,
      instanceId: crypto.randomUUID(),
    };
  }
}

export interface JwtVerificationKey {
  readonly kid?: string;
  readonly secret: string;
}

export interface JwtAuthenticatorOptions {
  secret?: string;
  secrets?: readonly string[];
  keys?: readonly JwtVerificationKey[];
  currentKeyId?: string;
  issuer?: string;
  audience?: string;
  maxTokenAge?: string | number;
  clockTolerance?: string | number;
}

export class JwtAuthenticator implements Authenticator {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly keys: Array<{ kid: string; secret: string; verifier: Uint8Array }>;
  private readonly maxTokenAge: string | number;
  private readonly clockTolerance: string | number;

  constructor(
    secretOrConfig: string | readonly string[] | readonly JwtVerificationKey[] | JwtAuthenticatorOptions = '',
    issuer?: string,
    audience?: string,
    options?: JwtAuthenticatorOptions
  ) {
    let config: JwtAuthenticatorOptions;
    if (typeof secretOrConfig === 'string' || Array.isArray(secretOrConfig)) {
      config = {
        ...(Array.isArray(secretOrConfig)
          ? { keys: secretOrConfig.map((entry, index) =>
              typeof entry === 'string'
                ? { kid: `key-${index}`, secret: entry }
                : entry
            ) }
          : { secret: secretOrConfig }),
        issuer,
        audience,
        ...options,
      };
    } else {
      config = secretOrConfig as JwtAuthenticatorOptions;
    }

    if (!config.issuer || config.issuer.trim() === '') {
      throw new Error('JWT issuer is required');
    }
    if (!config.audience || config.audience.trim() === '') {
      throw new Error('JWT audience is required');
    }

    const normalizedKeys = this.normalizeKeys(config).map((key, index) => ({
      kid: key.kid && key.kid.trim() !== '' ? key.kid.trim() : `key-${index}`,
      secret: key.secret,
    }));
    if (normalizedKeys.length === 0) {
      throw new Error('JWT signing secret is required');
    }

    for (const key of normalizedKeys) {
      if (typeof key.secret !== 'string' || key.secret.trim() === '') {
        throw new Error('JWT signing secret is required');
      }
      if (Buffer.from(key.secret, 'utf8').length < 32) {
        throw new Error('JWT signing secret must contain at least 32 bytes of key material');
      }
    }

    const uniqueKids = new Set(normalizedKeys.map((key) => key.kid));
    if (uniqueKids.size !== normalizedKeys.length) {
      throw new Error('JWT verification key identifiers must be unique');
    }

    this.issuer = config.issuer.trim();
    this.audience = config.audience.trim();
    this.keys = normalizedKeys.map((key) => ({
      kid: key.kid,
      secret: key.secret,
      verifier: new TextEncoder().encode(key.secret),
    }));
    this.maxTokenAge = config.maxTokenAge ?? '1h';
    this.clockTolerance = config.clockTolerance ?? 0;
  }

  private normalizeKeys(config: JwtAuthenticatorOptions): JwtVerificationKey[] {
    if (Array.isArray(config.keys) && config.keys.length > 0) {
      return config.keys as JwtVerificationKey[];
    }
    if (Array.isArray(config.secrets) && config.secrets.length > 0) {
      return config.secrets.map((secret, index) => ({ kid: `key-${index}`, secret }));
    }
    if (typeof config.secret === 'string' && config.secret.trim() !== '') {
      return [{ kid: config.currentKeyId?.trim() || 'default', secret: config.secret }];
    }
    return [];
  }

  private selectKey(kid: string | undefined): { kid: string; verifier: Uint8Array } | undefined {
    if (this.keys.length === 1 && kid === undefined) {
      return this.keys[0];
    }
    if (kid === undefined) {
      // Tokens without a kid are accepted only under the primary key.
      return this.keys[0];
    }
    return this.keys.find((key) => key.kid === kid);
  }

  async authenticate(credentials: ServiceCredentials): Promise<AuthenticationResult> {
    if (credentials.type !== 'jwt' || typeof credentials.jwtSecret !== 'string' || credentials.jwtSecret.trim() === '') {
      return { authenticated: false, error: 'Invalid credential type for JWT authenticator' };
    }

    try {
      let protectedHeader: { alg?: string; kid?: string };
      try {
        const { decodeProtectedHeader } = await import('jose');
        protectedHeader = decodeProtectedHeader(credentials.jwtSecret);
      } catch {
        return { authenticated: false, error: 'Invalid token' };
      }

      if (protectedHeader.alg !== 'HS256') {
        return { authenticated: false, error: 'Unsupported signing algorithm' };
      }

      const key = this.selectKey(protectedHeader.kid);
      if (!key) {
        return { authenticated: false, error: 'Invalid token' };
      }

      const { jwtVerify } = await import('jose');
      const { payload } = await jwtVerify(
        credentials.jwtSecret,
        key.verifier,
        {
          issuer: this.issuer,
          audience: this.audience,
          algorithms: ['HS256'],
          maxTokenAge: this.maxTokenAge,
          clockTolerance: this.clockTolerance,
          requiredClaims: ['exp', 'iat', 'nbf', 'sub'],
        }
      );

      if (typeof payload.sub !== 'string' || payload.sub.trim() === '') {
        return { authenticated: false, error: 'Missing or invalid subject claim' };
      }

      return {
        authenticated: true,
        identity: {
          serviceId: payload.sub.trim(),
          serviceName: typeof (payload as Record<string, unknown>)['name'] === 'string'
            ? (payload as Record<string, unknown>)['name'] as string
            : payload.sub.trim(),
          instanceId: typeof payload.jti === 'string' ? payload.jti : crypto.randomUUID(),
          credentials,
          getRegistration: () => { throw new Error('NotSupportedError: getRegistration is not supported by authenticator identity'); },
          sign: async () => { throw new Error('NotSupportedError: signing is not supported by authenticator identity'); },
          verify: async () => { throw new Error('NotSupportedError: verification is not supported by authenticator identity'); },
        },
      };
    } catch (_err) {
      return { authenticated: false, error: 'Invalid token' };
    }
  }

  async validateIdentity(identity: ServiceIdentity): Promise<boolean> {
    if (identity.credentials.type !== 'jwt' || typeof identity.credentials.jwtSecret !== 'string' || identity.credentials.jwtSecret.trim() === '') {
      return false;
    }

    const result = await this.authenticate(identity.credentials);
    return result.authenticated;
  }

  get verificationKeyIds(): readonly string[] {
    return this.keys.map((key) => key.kid);
  }

  addVerificationKey(kid: string, secret: string): void {
    if (typeof kid !== 'string' || kid.trim() === '') {
      throw new Error('JWT key identifier is required');
    }
    const normalizedKid = kid.trim();
    if (this.keys.some((key) => key.kid === normalizedKid)) {
      throw new Error('JWT key identifier already exists');
    }
    if (typeof secret !== 'string' || secret.trim() === '' || Buffer.from(secret, 'utf8').length < 32) {
      throw new Error('JWT signing secret must contain at least 32 bytes of key material');
    }
    this.keys.push({ kid: normalizedKid, secret, verifier: new TextEncoder().encode(secret) });
  }

  removeVerificationKey(kid: string): void {
    if (this.keys.length <= 1) {
      throw new Error('At least one JWT verification key must remain');
    }
    const normalizedKid = typeof kid === 'string' ? kid.trim() : '';
    const index = this.keys.findIndex((key) => key.kid === normalizedKid);
    if (index >= 0) {
      this.keys.splice(index, 1);
    }
  }
}

export interface ApiKeyAuthenticatorOptions {
  maxFailedAttempts?: number;
  lockoutDurationMs?: number;
  maxTrackedKeys?: number;
  maxApiKeyLength?: number;
}

interface StoredApiKey {
  verifier: Buffer;
  serviceId: string;
  serviceName: string;
}

interface FailureState {
  count: number;
  lockedUntilMs: number;
  lastSeenMs: number;
}

export class ApiKeyAuthenticator implements Authenticator {
  private readonly hmacKey: Buffer;
  private readonly maxFailedAttempts: number;
  private readonly lockoutDurationMs: number;
  private readonly maxTrackedKeys: number;
  private readonly maxApiKeyLength: number;

  // Stored verifiers only. The raw API key is not retained.
  private readonly verifiers: StoredApiKey[] = [];
  private readonly failures = new Map<string, FailureState>();

  constructor(
    options: ApiKeyAuthenticatorOptions | number = {},
    lockoutDurationMs?: number,
    maxTrackedKeys?: number,
  ) {
    this.hmacKey = randomBytes(32);

    if (typeof options === 'number') {
      this.maxFailedAttempts = Math.max(1, options);
      this.lockoutDurationMs = Math.max(0, lockoutDurationMs ?? 15_000);
      this.maxTrackedKeys = Math.max(1, maxTrackedKeys ?? 1000);
      this.maxApiKeyLength = 65_536;
      return;
    }

    const o = (options ?? {}) as ApiKeyAuthenticatorOptions;
    this.maxFailedAttempts = Math.max(1, o.maxFailedAttempts ?? 5);
    this.lockoutDurationMs = Math.max(0, o.lockoutDurationMs ?? 15_000);
    this.maxTrackedKeys = Math.max(1, o.maxTrackedKeys ?? 1000);
    this.maxApiKeyLength = Math.max(1, o.maxApiKeyLength ?? 65_536);
  }

  /**
   * Configurable injection point for equality checks around fixed-length
   * verifier buffers. The default implementation delegates to Node's
   * `crypto.timingSafeEqual`. Tests may override this method in a
   * subclass to assert that the integration calls it.
   */
  protected timingSafeEqual(left: Buffer, right: Buffer): boolean {
    if (left.length !== right.length) {
      return false;
    }
    return timingSafeEqual(left, right);
  }

  private deriveVerifier(apiKey: string): Buffer {
    return createHmac('sha256', this.hmacKey).update(apiKey, 'utf8').digest();
  }

  private nowMs(): number {
    // `process.hrtime.bigint()` is monotonic, unlike `Date.now()`.
    return Number(process.hrtime.bigint() / 1_000_000n);
  }

  private evictFailureState(now: number): void {
    // Remove expired lockout records first; this bounds long-lived state.
    for (const [key, state] of this.failures) {
      if (state.lockedUntilMs <= now && state.count < this.maxFailedAttempts) {
        this.failures.delete(key);
      }
    }

    if (this.failures.size < this.maxTrackedKeys) {
      return;
    }

    // Fall back to FIFO eviction if all tracked failures are still active.
    const oldest = this.failures.keys().next().value as string | undefined;
    if (oldest !== undefined) {
      this.failures.delete(oldest);
    }
  }

  private failureKey(apiKey: string): string {
    return createHmac('sha256', this.hmacKey).update('failure:', 'utf8').update(apiKey, 'utf8').digest('hex');
  }

  private recordFailure(apiKey: string, now: number): void {
    const key = this.failureKey(apiKey);
    if (!this.failures.has(key) && this.failures.size >= this.maxTrackedKeys) {
      this.evictFailureState(now);
    }

    const current = this.failures.get(key);
    const next: FailureState = current
      ? { count: current.count + 1, lockedUntilMs: current.lockedUntilMs, lastSeenMs: now }
      : { count: 1, lockedUntilMs: 0, lastSeenMs: now };

    if (next.count >= this.maxFailedAttempts && this.lockoutDurationMs > 0) {
      next.lockedUntilMs = now + this.lockoutDurationMs;
    }

    this.failures.set(key, next);
  }

  private resetFailure(apiKey: string): void {
    this.failures.delete(this.failureKey(apiKey));
  }

  private isLockedOut(apiKey: string, now: number): boolean {
    const state = this.failures.get(this.failureKey(apiKey));
    if (!state) {
      return false;
    }
    if (state.lockedUntilMs > now) {
      return true;
    }

    // Expired lockout records are removed rather than retained forever.
    if (state.lockedUntilMs > 0 && state.lockedUntilMs <= now) {
      this.failures.delete(this.failureKey(apiKey));
    }
    return false;
  }

  addKey(apiKey: string, serviceId: string, serviceName: string): void {
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      throw new Error('API key must be a non-empty string');
    }
    if (typeof serviceId !== 'string' || serviceId.trim() === '') {
      throw new Error('Service ID must be a non-empty string');
    }
    if (typeof serviceName !== 'string') {
      throw new Error('Service name must be a string');
    }

    const verifier = this.deriveVerifier(apiKey);
    this.verifiers.splice(0, this.verifiers.length, ...this.verifiers.filter((entry) => !this.timingSafeEqual(entry.verifier, verifier)));
    this.verifiers.push({ verifier, serviceId, serviceName });
  }

  removeKey(apiKey: string): void {
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      return;
    }
    const verifier = this.deriveVerifier(apiKey);
    for (let index = this.verifiers.length - 1; index >= 0; index -= 1) {
      const entry = this.verifiers[index];
      if (entry && this.timingSafeEqual(entry.verifier, verifier)) {
        this.verifiers.splice(index, 1);
      }
    }
  }

  async authenticate(credentials: ServiceCredentials): Promise<AuthenticationResult> {
    if (credentials.type !== 'api-key' || typeof credentials.apiKey !== 'string' || credentials.apiKey.trim() === '') {
      return { authenticated: false, error: 'Invalid credential type for API key authenticator' };
    }

    if (credentials.apiKey.length > this.maxApiKeyLength) {
      return { authenticated: false, error: 'Invalid API key' };
    }

    const now = this.nowMs();
    if (this.isLockedOut(credentials.apiKey, now)) {
      // Keep the failure reason generic to avoid distinguishing locked-out
      // attempts from ordinary invalid credentials.
      return { authenticated: false, error: 'Invalid API key' };
    }

    const candidateVerifier = this.deriveVerifier(credentials.apiKey);
    let keyInfo: { serviceId: string; serviceName: string } | undefined;
    for (const stored of this.verifiers) {
      if (this.timingSafeEqual(candidateVerifier, stored.verifier)) {
        keyInfo = stored;
        break;
      }
    }

    if (!keyInfo) {
      this.recordFailure(credentials.apiKey, now);
      return { authenticated: false, error: 'Invalid API key' };
    }

    this.resetFailure(credentials.apiKey);
    return {
      authenticated: true,
      identity: {
        serviceId: keyInfo.serviceId,
        serviceName: keyInfo.serviceName,
        instanceId: crypto.randomUUID(),
        credentials,
        getRegistration: () => ({} as ServiceRegistration),
        sign: async () => { throw new Error('NotSupportedError: signing is not supported by authenticator identity'); },
        verify: async () => { throw new Error('NotSupportedError: verification is not supported by authenticator identity'); },
      },
    };
  }

  async validateIdentity(identity: ServiceIdentity): Promise<boolean> {
    if (identity.credentials.type !== 'api-key' || typeof identity.credentials.apiKey !== 'string' || identity.credentials.apiKey.trim() === '') {
      return false;
    }
    if (identity.credentials.apiKey.length > this.maxApiKeyLength) {
      return false;
    }

    const candidateVerifier = this.deriveVerifier(identity.credentials.apiKey);
    return this.verifiers.some((stored) => this.timingSafeEqual(candidateVerifier, stored.verifier));
  }

  /**
   * Return only non-secret verifier metadata for diagnostics. Verifier bytes
   * and the HMAC key are deliberately excluded.
   */
  get keyCount(): number {
    return this.verifiers.length;
  }
}
export function createAuthenticator(
  type: 'x509' | 'jwt' | 'api-key',
  options: {
    trustedCAs?: string[];
    secret?: string;
    issuer?: string;
    audience?: string;
  } = {}
): Authenticator {
  switch (type) {
    case 'x509':
      return new X509Authenticator(options.trustedCAs);
    case 'jwt':
      if (!options.secret || !options.issuer || !options.audience) {
        throw new Error('JWT authenticator requires secret, issuer, and audience');
      }
      return new JwtAuthenticator(options.secret, options.issuer, options.audience);
    case 'api-key':
      return new ApiKeyAuthenticator(options as ApiKeyAuthenticatorOptions);
    default:
      throw new Error(`Unknown authenticator type: ${type}`);
  }
}