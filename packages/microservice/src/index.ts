export * from './core/index.js';
export * from './contracts/index.js';
export * from './security/index.js';
export * from './registry/index.js';
export * from './transport/index.js';
export * from './adapters/rpc/index.js';
export * from './adapters/network/index.js';
export * from './observability/index.js';
export * from './internal/index.js';
export * from './config/index.js';

export type { 
  ServiceIdentity 
} from './identity/service-identity.js';
export { 
  createServiceIdentity, 
  createIdentityFromCredentials 
} from './identity/service-identity.js';
export * from './identity/credentials.js';
export * from './identity/authentication.js';
export * from './identity/authorization.js';

export { createMicroservice } from './core/application.js';