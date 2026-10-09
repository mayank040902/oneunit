import { ServiceIdentity } from './service-identity.js';
import { ServiceCredentials } from './credentials.js';

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

      if (this.trustedCAs.length > 0) {
        const trusted = await this.verifyChain(cert);
        if (!trusted) {
          return { authenticated: false, error: 'Certificate not trusted' };
        }
      }

      const identity = this.extractIdentity(cert);
      
      return {
        authenticated: true,
        identity: {
          serviceId: identity.serviceId,
          serviceName: identity.serviceName,
          instanceId: identity.instanceId,
          credentials,
          getRegistration: () => ({} as any),
          sign: async () => new Uint8Array(),
          verify: async () => false,
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

  private async parseCertificate(pem: string): Promise<any> {
    const { X509Certificate } = await import('crypto');
    return new X509Certificate(pem);
  }

  private isExpired(cert: any): boolean {
    return Date.now() > cert.validTo.getTime();
  }

  private async verifyChain(cert: any): Promise<boolean> {
    for (const caPem of this.trustedCAs) {
      try {
        const ca = await this.parseCertificate(caPem);
        const verified = cert.verify(ca.publicKey);
        if (verified) return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  private extractIdentity(cert: any): { serviceId: string; serviceName: string; instanceId: string } {
    const subject = cert.subject;
    const serviceIdMatch = subject.match(/CN=([^,]+)/);
    const serviceId = serviceIdMatch ? serviceIdMatch[1] : 'unknown';
    
    return {
      serviceId,
      serviceName: serviceId,
      instanceId: crypto.randomUUID(),
    };
  }
}

export class JwtAuthenticator implements Authenticator {
  private secret: string;
  private issuer: string;
  private audience: string;

  constructor(secret: string, issuer: string, audience: string) {
    this.secret = secret;
    this.issuer = issuer;
    this.audience = audience;
  }

  async authenticate(credentials: ServiceCredentials): Promise<AuthenticationResult> {
    if (credentials.type !== 'jwt' || !credentials.jwtSecret) {
      return { authenticated: false, error: 'Invalid credential type for JWT authenticator' };
    }

    try {
      const { jwtVerify } = await import('jose');
      const { payload } = await jwtVerify(
        credentials.jwtSecret,
        new TextEncoder().encode(this.secret),
        { issuer: this.issuer, audience: this.audience }
      );

      return {
        authenticated: true,
        identity: {
          serviceId: payload.sub as string,
          serviceName: (payload as Record<string, unknown>)['name'] as string,
          instanceId: payload.jti as string,
          credentials,
          getRegistration: () => ({} as any),
          sign: async () => new Uint8Array(),
          verify: async () => false,
        },
      };
    } catch (err) {
      return { authenticated: false, error: (err as Error).message };
    }
  }

  async validateIdentity(identity: ServiceIdentity): Promise<boolean> {
    if (identity.credentials.type !== 'jwt' || !identity.credentials.jwtSecret) {
      return false;
    }

    try {
      const { jwtVerify } = await import('jose');
      await jwtVerify(
        identity.credentials.jwtSecret,
        new TextEncoder().encode(this.secret),
        { issuer: this.issuer, audience: this.audience }
      );
      return true;
    } catch {
      return false;
    }
  }
}

export class ApiKeyAuthenticator implements Authenticator {
  private validKeys: Map<string, { serviceId: string; serviceName: string }> = new Map();

  addKey(apiKey: string, serviceId: string, serviceName: string): void {
    this.validKeys.set(apiKey, { serviceId, serviceName });
  }

  removeKey(apiKey: string): void {
    this.validKeys.delete(apiKey);
  }

  async authenticate(credentials: ServiceCredentials): Promise<AuthenticationResult> {
    if (credentials.type !== 'api-key' || !credentials.apiKey) {
      return { authenticated: false, error: 'Invalid credential type for API key authenticator' };
    }

    const keyInfo = this.validKeys.get(credentials.apiKey);
    if (!keyInfo) {
      return { authenticated: false, error: 'Invalid API key' };
    }

    return {
      authenticated: true,
      identity: {
        serviceId: keyInfo.serviceId,
        serviceName: keyInfo.serviceName,
        instanceId: crypto.randomUUID(),
        credentials,
        getRegistration: () => ({} as any),
        sign: async () => new Uint8Array(),
        verify: async () => false,
      },
    };
  }

  async validateIdentity(identity: ServiceIdentity): Promise<boolean> {
    if (identity.credentials.type !== 'api-key' || !identity.credentials.apiKey) {
      return false;
    }
    return this.validKeys.has(identity.credentials.apiKey);
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
      return new ApiKeyAuthenticator();
    default:
      throw new Error(`Unknown authenticator type: ${type}`);
  }
}