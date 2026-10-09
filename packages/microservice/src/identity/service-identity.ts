import { MicroserviceConfig, ServiceConfig, ServiceCredentials } from '../config/schema.js';
import { ServiceRegistration } from '../contracts/schemas.js';

export interface ServiceIdentity {
  readonly serviceId: string;
  readonly serviceName: string;
  readonly instanceId: string;
  readonly credentials: ServiceCredentials;
  
  getRegistration(): ServiceRegistration;
  sign(data: Uint8Array): Promise<Uint8Array>;
  verify(data: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

export function createServiceIdentity(config: ServiceConfig): ServiceIdentity {
  const instanceId = crypto.randomUUID();
  
  return {
    serviceId: config.id,
    serviceName: config.name,
    instanceId,
    credentials: {
      type: 'x509',
      certificate: config.credentials?.certificate,
      privateKey: config.credentials?.privateKey,
      caCert: config.credentials?.caCert,
      issuedAt: Date.now(),
      issuer: config.name,
    },
    
    getRegistration(): ServiceRegistration {
      return {
        serviceId: config.id,
        serviceName: config.name,
        instanceId,
        endpoints: config.endpoints?.map(e => ({
          protocol: e.protocol,
          host: e.host,
          port: e.port,
          tls: e.tls,
        })) ?? [],
        capabilities: config.capabilities ?? [],
        metadata: config.metadata ?? {},
        registeredAt: Date.now(),
      };
    },
    
    async sign(data: Uint8Array): Promise<Uint8Array> {
      if (this.credentials.type === 'x509' && this.credentials.privateKey) {
        const key = await crypto.subtle.importKey(
          'pkcs8',
          new TextEncoder().encode(this.credentials.privateKey),
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['sign']
        );
        return new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, data as BufferSource));
      }
      throw new Error('Signing not supported for this credential type');
    },
    
    async verify(data: Uint8Array, signature: Uint8Array): Promise<boolean> {
      if (this.credentials.type === 'x509' && this.credentials.certificate) {
        const key = await crypto.subtle.importKey(
          'spki',
          new TextEncoder().encode(this.credentials.certificate),
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify']
        );
        return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature as BufferSource, data as BufferSource);
      }
      throw new Error('Verification not supported for this credential type');
    },
  };
}

export function createIdentityFromCredentials(
  serviceId: string,
  serviceName: string,
  credentials: ServiceCredentials
): ServiceIdentity {
  const instanceId = crypto.randomUUID();
  
  return {
    serviceId,
    serviceName,
    instanceId,
    credentials,
    
    getRegistration(): ServiceRegistration {
      return {
        serviceId,
        serviceName,
        instanceId,
        endpoints: [],
        capabilities: [],
        metadata: {},
        registeredAt: Date.now(),
      };
    },
    
    async sign(data: Uint8Array): Promise<Uint8Array> {
      if (credentials.type === 'x509' && credentials.privateKey) {
        const key = await crypto.subtle.importKey(
          'pkcs8',
          new TextEncoder().encode(credentials.privateKey),
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['sign']
        );
        return new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, data as BufferSource));
      }
      throw new Error('Signing not supported for this credential type');
    },
    
    async verify(data: Uint8Array, signature: Uint8Array): Promise<boolean> {
      if (credentials.type === 'x509' && credentials.certificate) {
        const key = await crypto.subtle.importKey(
          'spki',
          new TextEncoder().encode(credentials.certificate),
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify']
        );
        return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature as BufferSource, data as BufferSource);
      }
      throw new Error('Verification not supported for this credential type');
    },
  };
}