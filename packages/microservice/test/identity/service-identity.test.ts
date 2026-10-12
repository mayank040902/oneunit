import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ServiceIdentity,
  createServiceIdentity,
  createIdentityFromCredentials,
} from '../../src/identity/service-identity.js';
import { ServiceCredentials } from '../../src/config/schema.js';

describe('ServiceIdentity', () => {
  const validConfig = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    name: 'test-service',
    instanceId: '123e4567-e89b-12d3-a456-426614174001',
    credentials: undefined,
    endpoints: [
      { protocol: 'tcp' as const, host: 'localhost', port: 8080, tls: false },
    ],
    capabilities: ['rpc', 'messaging'],
    metadata: { version: '1.0.0' },
  };

  it('should create a service identity from config', () => {
    const identity = createServiceIdentity(validConfig);

    expect(identity.serviceId).toBe(validConfig.id);
    expect(identity.serviceName).toBe(validConfig.name);
    expect(identity.instanceId).toBeDefined();
    expect(typeof identity.instanceId).toBe('string');
    expect(identity.credentials).toBeDefined();
    expect(identity.credentials.type).toBe('x509');
    expect(identity.credentials.issuedAt).toBeDefined();
    expect(identity.credentials.issuer).toBe(validConfig.name);
  });

  it('should generate unique instance IDs', () => {
    const identity1 = createServiceIdentity(validConfig);
    const identity2 = createServiceIdentity(validConfig);

    expect(identity1.instanceId).not.toBe(identity2.instanceId);
  });

  it('should return valid registration', () => {
    const identity = createServiceIdentity(validConfig);
    const registration = identity.getRegistration();

    expect(registration.serviceId).toBe(validConfig.id);
    expect(registration.serviceName).toBe(validConfig.name);
    expect(registration.instanceId).toBe(identity.instanceId);
    expect(registration.endpoints).toHaveLength(1);
    expect(registration.endpoints[0].protocol).toBe('tcp');
    expect(registration.capabilities).toEqual(['rpc', 'messaging']);
    expect(registration.metadata).toEqual({ version: '1.0.0' });
    expect(registration.registeredAt).toBeDefined();
  });

  it('should return empty endpoints when not configured', () => {
    const config = { ...validConfig, endpoints: undefined };
    const identity = createServiceIdentity(config);
    const registration = identity.getRegistration();

    expect(registration.endpoints).toEqual([]);
  });

  it('should return empty capabilities when not configured', () => {
    const config = { ...validConfig, capabilities: undefined };
    const identity = createServiceIdentity(config);
    const registration = identity.getRegistration();

    expect(registration.capabilities).toEqual([]);
  });

  it('should return empty metadata when not configured', () => {
    const config = { ...validConfig, metadata: undefined };
    const identity = createServiceIdentity(config);
    const registration = identity.getRegistration();

    expect(registration.metadata).toEqual({});
  });

  it('should include credentials when provided in config', () => {
    const credentials: ServiceCredentials = {
      type: 'x509',
      certificate: 'cert-data',
      privateKey: 'key-data',
      caCert: 'ca-data',
      issuedAt: 1234567890,
      issuer: 'test-issuer',
    };
    const config = { ...validConfig, credentials };
    const identity = createServiceIdentity(config);

    expect(identity.credentials).toEqual(credentials);
    expect(identity.credentials.type).toBe('x509');
    expect(identity.credentials.issuedAt).toBe(1234567890);
    expect(identity.credentials.issuer).toBe('test-issuer');
  });

  it('should preserve jwt credentials', () => {
    const credentials: ServiceCredentials = {
      type: 'jwt',
      jwtSecret: 'secret',
      issuedAt: Date.now(),
      issuer: 'test-issuer',
    };
    const identity = createServiceIdentity({ ...validConfig, credentials });

    expect(identity.credentials.type).toBe('jwt');
    expect(identity.credentials.jwtSecret).toBe('secret');
  });

  it('should preserve api-key credentials', () => {
    const credentials: ServiceCredentials = {
      type: 'api-key',
      apiKey: 'key',
      issuedAt: Date.now(),
      issuer: 'test-issuer',
    };
    const identity = createServiceIdentity({ ...validConfig, credentials });

    expect(identity.credentials.type).toBe('api-key');
    expect(identity.credentials.apiKey).toBe('key');
  });

  it('should preserve mtls credentials', () => {
    const credentials: ServiceCredentials = {
      type: 'mtls',
      certificate: 'cert-data',
      privateKey: 'key-data',
      caCert: 'ca-data',
      issuedAt: Date.now(),
      issuer: 'test-issuer',
    };
    const identity = createServiceIdentity({ ...validConfig, credentials });

    expect(identity.credentials.type).toBe('mtls');
    expect(identity.credentials.certificate).toBe('cert-data');
    expect(identity.credentials.privateKey).toBe('key-data');
  });

  it('should reject jwt credentials without jwtSecret', () => {
    const credentials: ServiceCredentials = {
      type: 'jwt',
      issuedAt: Date.now(),
      issuer: 'test-issuer',
    };
    expect(() => createServiceIdentity({ ...validConfig, credentials })).toThrow(
      'jwt credentials require jwtSecret',
    );
  });

  it('should reject api-key credentials without apiKey', () => {
    const credentials: ServiceCredentials = {
      type: 'api-key',
      issuedAt: Date.now(),
      issuer: 'test-issuer',
    };
    expect(() => createServiceIdentity({ ...validConfig, credentials })).toThrow(
      'api-key credentials require apiKey',
    );
  });

  it('should reject x509 credentials without privateKey', () => {
    const credentials: ServiceCredentials = {
      type: 'x509',
      certificate: 'cert-data',
      issuedAt: Date.now(),
      issuer: 'test-issuer',
    };
    expect(() => createServiceIdentity({ ...validConfig, credentials })).toThrow(
      'x509 credentials require both certificate and privateKey',
    );
  });

  it('should reject unsupported credential types', () => {
    const credentials = {
      type: 'kerberos',
      issuedAt: Date.now(),
      issuer: 'test-issuer',
    } as unknown as ServiceCredentials;
    expect(() => createServiceIdentity({ ...validConfig, credentials })).toThrow(
      'Unsupported credential type: kerberos',
    );
  });
});

describe('createIdentityFromCredentials', () => {
  const credentials: ServiceCredentials = {
    type: 'x509',
    certificate: 'cert-data',
    privateKey: 'key-data',
    caCert: 'ca-data',
    issuedAt: Date.now(),
    issuer: 'test-issuer',
  };

  it('should create identity from credentials', () => {
    const identity = createIdentityFromCredentials(
      '123e4567-e89b-12d3-a456-426614174000',
      'test-service',
      credentials
    );

    expect(identity.serviceId).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(identity.serviceName).toBe('test-service');
    expect(identity.instanceId).toBeDefined();
    expect(identity.credentials).toBe(credentials);
  });

  it('should generate unique instance IDs', () => {
    const identity1 = createIdentityFromCredentials('svc1', 'service1', credentials);
    const identity2 = createIdentityFromCredentials('svc2', 'service2', credentials);

    expect(identity1.instanceId).not.toBe(identity2.instanceId);
  });

  it('should return minimal registration', () => {
    const identity = createIdentityFromCredentials('svc', 'service', credentials);
    const registration = identity.getRegistration();

    expect(registration.serviceId).toBe('svc');
    expect(registration.serviceName).toBe('service');
    expect(registration.instanceId).toBe(identity.instanceId);
    expect(registration.endpoints).toEqual([]);
    expect(registration.capabilities).toEqual([]);
    expect(registration.metadata).toEqual({});
    expect(registration.registeredAt).toBeDefined();
  });
});

describe('ServiceIdentity sign/verify', () => {
  it('should throw for unsupported credential type in sign', async () => {
    const identity = createIdentityFromCredentials('svc', 'service', {
      type: 'api-key',
      apiKey: 'test-key',
      issuedAt: Date.now(),
    });

    await expect(identity.sign(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      'Signing not supported for credential type: api-key'
    );
  });

  it('should throw for unsupported credential type in verify', async () => {
    const identity = createIdentityFromCredentials('svc', 'service', {
      type: 'api-key',
      apiKey: 'test-key',
      issuedAt: Date.now(),
    });

    await expect(identity.verify(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]))).rejects.toThrow(
      'Verification not supported for credential type: api-key'
    );
  });

  it('should throw when x509 credentials missing private key', () => {
    expect(() =>
      createIdentityFromCredentials('svc', 'service', {
        type: 'x509',
        certificate: 'cert-data',
        issuedAt: Date.now(),
      })
    ).toThrow('x509 credentials require both certificate and privateKey');
  });

  it('should throw when x509 credentials missing certificate', () => {
    expect(() =>
      createIdentityFromCredentials('svc', 'service', {
        type: 'x509',
        privateKey: 'key-data',
        issuedAt: Date.now(),
      })
    ).toThrow('x509 credentials require both certificate and privateKey');
  });

  it('should sign and verify with PEM-encoded key material', async () => {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const toPem = (der: ArrayBuffer, label: string): string => {
      const base64 = Buffer.from(der).toString('base64');
      const lines = base64.replace(/(.{64})/g, '$1\n').trim();
      return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
    };

    const identity = createIdentityFromCredentials('svc', 'service', {
      type: 'x509',
      certificate: toPem(spki, 'PUBLIC KEY'),
      privateKey: toPem(pkcs8, 'PRIVATE KEY'),
      issuedAt: Date.now(),
      issuer: 'test-issuer',
    });

    const data = new Uint8Array([1, 2, 3]);
    const signature = await identity.sign(data);

    expect(await identity.verify(data, signature)).toBe(true);
    expect(await identity.verify(new Uint8Array([4, 5, 6]), signature)).toBe(false);
  });

  it('should reject PEM material with no Base64 payload', async () => {
    const identity = createIdentityFromCredentials('svc', 'service', {
      type: 'x509',
      certificate: '-----BEGIN PUBLIC KEY-----\n-----END PUBLIC KEY-----\n',
      privateKey: '-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----\n',
      issuedAt: Date.now(),
      issuer: 'test-issuer',
    });

    await expect(identity.sign(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      'PEM key material contains no Base64 payload'
    );
  });
});