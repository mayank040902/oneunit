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
      issuedAt: Date.now(),
      issuer: 'test-issuer',
    };
    const config = { ...validConfig, credentials };
    const identity = createServiceIdentity(config);

    expect(identity.credentials.certificate).toBe('cert-data');
    expect(identity.credentials.privateKey).toBe('key-data');
    expect(identity.credentials.caCert).toBe('ca-data');
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
  // These tests require actual crypto keys to work properly
  // We test the error cases that don't require valid keys

  it('should throw for unsupported credential type in sign', async () => {
    const identity = createIdentityFromCredentials('svc', 'service', {
      type: 'api-key',
      apiKey: 'test-key',
      issuedAt: Date.now(),
    });

    await expect(identity.sign(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      'Signing not supported for this credential type'
    );
  });

  it('should throw for unsupported credential type in verify', async () => {
    const identity = createIdentityFromCredentials('svc', 'service', {
      type: 'api-key',
      apiKey: 'test-key',
      issuedAt: Date.now(),
    });

    await expect(identity.verify(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]))).rejects.toThrow(
      'Verification not supported for this credential type'
    );
  });

  it('should throw when x509 credentials missing private key for sign', async () => {
    const identity = createIdentityFromCredentials('svc', 'service', {
      type: 'x509',
      certificate: 'cert-data',
      issuedAt: Date.now(),
    });

    await expect(identity.sign(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      'Signing not supported for this credential type'
    );
  });

  it('should throw when x509 credentials missing certificate for verify', async () => {
    const identity = createIdentityFromCredentials('svc', 'service', {
      type: 'x509',
      privateKey: 'key-data',
      issuedAt: Date.now(),
    });

    await expect(identity.verify(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]))).rejects.toThrow(
      'Verification not supported for this credential type'
    );
  });
});