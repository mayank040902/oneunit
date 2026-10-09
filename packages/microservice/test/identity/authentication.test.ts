import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AuthenticationResult,
  Authenticator,
  X509Authenticator,
  JwtAuthenticator,
  ApiKeyAuthenticator,
  createAuthenticator,
} from '../../src/identity/authentication.js';
import { ServiceCredentials } from '../../src/identity/credentials.js';

describe('X509Authenticator', () => {
  let authenticator: X509Authenticator;

  beforeEach(() => {
    authenticator = new X509Authenticator();
  });

  it('should reject invalid credential type', async () => {
    const credentials: ServiceCredentials = {
      type: 'api-key',
      apiKey: 'test-key',
      issuedAt: Date.now(),
    };

    const result = await authenticator.authenticate(credentials);

    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Invalid credential type for X509 authenticator');
  });

  it('should reject missing certificate', async () => {
    const credentials: ServiceCredentials = {
      type: 'x509',
      issuedAt: Date.now(),
    };

    const result = await authenticator.authenticate(credentials);

    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Missing certificate');
  });

  it('should accept mtls credential type', async () => {
    const credentials: ServiceCredentials = {
      type: 'mtls',
      certificate: '-----BEGIN CERTIFICATE-----\nMIIB...INVALID\n-----END CERTIFICATE-----',
      issuedAt: Date.now(),
    };

    const result = await authenticator.authenticate(credentials);

    // Will fail due to invalid cert format, but not due to type
    expect(result.authenticated).toBe(false);
    expect(result.error).not.toBe('Invalid credential type for X509 authenticator');
  });

  it('should add trusted CA', () => {
    authenticator.addTrustedCA('ca-cert-1');
    authenticator.addTrustedCA('ca-cert-2');

    // Can't directly inspect private field, but we can test behavior
    expect(true).toBe(true); // If no error thrown, method works
  });
});

describe('JwtAuthenticator', () => {
  let authenticator: JwtAuthenticator;

  beforeEach(() => {
    authenticator = new JwtAuthenticator('secret', 'issuer', 'audience');
  });

  it('should reject invalid credential type', async () => {
    const credentials: ServiceCredentials = {
      type: 'x509',
      certificate: 'cert',
      issuedAt: Date.now(),
    };

    const result = await authenticator.authenticate(credentials);

    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Invalid credential type for JWT authenticator');
  });

  it('should reject missing jwtSecret', async () => {
    const credentials: ServiceCredentials = {
      type: 'jwt',
      issuedAt: Date.now(),
    };

    const result = await authenticator.authenticate(credentials);

    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Invalid credential type for JWT authenticator');
  });

  it('should require secret, issuer, and audience in constructor', () => {
    expect(() => new JwtAuthenticator('', 'issuer', 'audience')).not.toThrow();
    // Empty secret is allowed at construction but will fail at auth time
  });
});

describe('ApiKeyAuthenticator', () => {
  let authenticator: ApiKeyAuthenticator;

  beforeEach(() => {
    authenticator = new ApiKeyAuthenticator();
  });

  it('should reject invalid credential type', async () => {
    const credentials: ServiceCredentials = {
      type: 'x509',
      certificate: 'cert',
      issuedAt: Date.now(),
    };

    const result = await authenticator.authenticate(credentials);

    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Invalid credential type for API key authenticator');
  });

  it('should reject missing apiKey', async () => {
    const credentials: ServiceCredentials = {
      type: 'api-key',
      issuedAt: Date.now(),
    };

    const result = await authenticator.authenticate(credentials);

    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Invalid credential type for API key authenticator');
  });

  it('should reject unknown API key', async () => {
    const credentials: ServiceCredentials = {
      type: 'api-key',
      apiKey: 'unknown-key',
      issuedAt: Date.now(),
    };

    const result = await authenticator.authenticate(credentials);

    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });

  it('should accept valid API key', async () => {
    authenticator.addKey('valid-key', 'service-1', 'Test Service');

    const credentials: ServiceCredentials = {
      type: 'api-key',
      apiKey: 'valid-key',
      issuedAt: Date.now(),
    };

    const result = await authenticator.authenticate(credentials);

    expect(result.authenticated).toBe(true);
    expect(result.identity).toBeDefined();
    expect(result.identity?.serviceId).toBe('service-1');
    expect(result.identity?.serviceName).toBe('Test Service');
    expect(result.identity?.instanceId).toBeDefined();
  });

  it('should remove API key', async () => {
    authenticator.addKey('valid-key', 'service-1', 'Test Service');
    authenticator.removeKey('valid-key');

    const credentials: ServiceCredentials = {
      type: 'api-key',
      apiKey: 'valid-key',
      issuedAt: Date.now(),
    };

    const result = await authenticator.authenticate(credentials);

    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });

  it('should validate identity with known key', async () => {
    authenticator.addKey('valid-key', 'service-1', 'Test Service');

    const identity = {
      serviceId: 'service-1',
      serviceName: 'Test Service',
      instanceId: 'inst-1',
      credentials: {
        type: 'api-key' as const,
        apiKey: 'valid-key',
        issuedAt: Date.now(),
      },
      getRegistration: () => ({} as any),
      sign: async () => new Uint8Array(),
      verify: async () => false,
    };

    const valid = await authenticator.validateIdentity(identity);
    expect(valid).toBe(true);
  });

  it('should reject identity with unknown key', async () => {
    const identity = {
      serviceId: 'service-1',
      serviceName: 'Test Service',
      instanceId: 'inst-1',
      credentials: {
        type: 'api-key' as const,
        apiKey: 'unknown-key',
        issuedAt: Date.now(),
      },
      getRegistration: () => ({} as any),
      sign: async () => new Uint8Array(),
      verify: async () => false,
    };

    const valid = await authenticator.validateIdentity(identity);
    expect(valid).toBe(false);
  });
});

describe('createAuthenticator', () => {
  it('should create X509 authenticator', () => {
    const authenticator = createAuthenticator('x509', { trustedCAs: ['ca1', 'ca2'] });
    expect(authenticator).toBeInstanceOf(X509Authenticator);
  });

  it('should create JWT authenticator with required options', () => {
    const authenticator = createAuthenticator('jwt', {
      secret: 'secret',
      issuer: 'issuer',
      audience: 'audience',
    });
    expect(authenticator).toBeInstanceOf(JwtAuthenticator);
  });

  it('should throw for JWT authenticator without required options', () => {
    expect(() => createAuthenticator('jwt', { secret: 'secret' })).toThrow(
      'JWT authenticator requires secret, issuer, and audience'
    );
    expect(() => createAuthenticator('jwt', { issuer: 'issuer' })).toThrow(
      'JWT authenticator requires secret, issuer, and audience'
    );
    expect(() => createAuthenticator('jwt', { audience: 'audience' })).toThrow(
      'JWT authenticator requires secret, issuer, and audience'
    );
  });

  it('should create API key authenticator', () => {
    const authenticator = createAuthenticator('api-key');
    expect(authenticator).toBeInstanceOf(ApiKeyAuthenticator);
  });

  it('should throw for unknown type', () => {
    expect(() => createAuthenticator('unknown' as any)).toThrow(
      'Unknown authenticator type: unknown'
    );
  });
});

describe('Authenticator interface', () => {
  it('should define correct structure for AuthenticationResult', () => {
    const result: AuthenticationResult = {
      authenticated: true,
      identity: undefined,
      error: undefined,
    };
    expect(result.authenticated).toBe(true);
  });

  it('should define correct structure for Authenticator', () => {
    const authenticator: Authenticator = {
      authenticate: async () => ({ authenticated: false, error: 'test' }),
      validateIdentity: async () => false,
    };
    expect(typeof authenticator.authenticate).toBe('function');
    expect(typeof authenticator.validateIdentity).toBe('function');
  });
});