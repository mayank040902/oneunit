import { ServiceConfig, ServiceCredentials } from '../config/schema.js';
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

const CREDENTIAL_TYPES = ['x509', 'jwt', 'api-key', 'mtls'] as const;

function isSupportedCredentialType(type: unknown): type is ServiceCredentials['type'] {
  return (
    typeof type === 'string' &&
    (CREDENTIAL_TYPES as readonly string[]).includes(type)
  );
}

export function validateCredentials(credentials: ServiceCredentials): void {
  if (!isSupportedCredentialType(credentials.type)) {
    throw new Error(
      `Unsupported credential type: ${String((credentials as { type: unknown }).type)}`,
    );
  }

  switch (credentials.type) {
    case 'x509':
    case 'mtls':
      if (!credentials.certificate || !credentials.privateKey) {
        throw new Error(
          `${credentials.type} credentials require both certificate and privateKey`,
        );
      }
      break;
    case 'jwt':
      if (!credentials.jwtSecret) {
        throw new Error('jwt credentials require jwtSecret');
      }
      break;
    case 'api-key':
      if (!credentials.apiKey) {
        throw new Error('api-key credentials require apiKey');
      }
      break;
  }
}

// Key material may be PEM text ("-----BEGIN …-----" headers with a
// Base64 payload) or, for backwards compatibility, a string holding
// raw DER bytes. Web Crypto imports DER, so PEM is decoded to its
// DER payload before import.
function decodeKeyMaterial(material: string): Uint8Array<ArrayBuffer> {
  const trimmed = material.trim();
  const firstLine = trimmed.split('\n', 1)[0] ?? '';
  if (firstLine.startsWith('-----BEGIN') && firstLine.endsWith('-----')) {
    const base64 = trimmed
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('-----'))
      .join('');
    const der = Buffer.from(base64, 'base64');
    if (der.length === 0) {
      throw new Error('PEM key material contains no Base64 payload');
    }
    const bytes = new Uint8Array(der.byteLength);
    bytes.set(der);
    return bytes;
  }
  return new TextEncoder().encode(material);
}

function isCertificateBased(type: ServiceCredentials['type']): boolean {
  return type === 'x509' || type === 'mtls';
}

export function createServiceIdentity(config: ServiceConfig): ServiceIdentity {
  const instanceId = crypto.randomUUID();

  // Preserved verbatim when configured: the credential type and every
  // field (including issuedAt/issuer) survive into the identity. When
  // no credentials are configured, a placeholder x509 block is created;
  // its sign/verify operations fail until material is supplied.
  const credentials: ServiceCredentials = config.credentials
    ? { ...config.credentials }
    : {
        type: 'x509',
        issuedAt: Date.now(),
        issuer: config.name,
      };

  if (config.credentials) {
    validateCredentials(credentials);
  }

  return {
    serviceId: config.id,
    serviceName: config.name,
    instanceId,
    credentials,

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
      if (isCertificateBased(credentials.type) && credentials.privateKey) {
        const key = await crypto.subtle.importKey(
          'pkcs8',
          decodeKeyMaterial(credentials.privateKey),
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['sign']
        );
        return new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, data as BufferSource));
      }
      throw new Error(`Signing not supported for credential type: ${credentials.type}`);
    },

    async verify(data: Uint8Array, signature: Uint8Array): Promise<boolean> {
      if (isCertificateBased(credentials.type) && credentials.certificate) {
        const key = await crypto.subtle.importKey(
          'spki',
          decodeKeyMaterial(credentials.certificate),
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify']
        );
        return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature as BufferSource, data as BufferSource);
      }
      throw new Error(`Verification not supported for credential type: ${credentials.type}`);
    },
  };
}

export function createIdentityFromCredentials(
  serviceId: string,
  serviceName: string,
  credentials: ServiceCredentials
): ServiceIdentity {
  const instanceId = crypto.randomUUID();

  validateCredentials(credentials);

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
      if (isCertificateBased(credentials.type) && credentials.privateKey) {
        const key = await crypto.subtle.importKey(
          'pkcs8',
          decodeKeyMaterial(credentials.privateKey),
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['sign']
        );
        return new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, data as BufferSource));
      }
      throw new Error(`Signing not supported for credential type: ${credentials.type}`);
    },

    async verify(data: Uint8Array, signature: Uint8Array): Promise<boolean> {
      if (isCertificateBased(credentials.type) && credentials.certificate) {
        const key = await crypto.subtle.importKey(
          'spki',
          decodeKeyMaterial(credentials.certificate),
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify']
        );
        return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature as BufferSource, data as BufferSource);
      }
      throw new Error(`Verification not supported for credential type: ${credentials.type}`);
    },
  };
}
