import { LifecycleManager } from './lifecycle.js';
import { Transport } from './capabilities.js';
import { MicroserviceConfig, ServiceConfig } from '../config/schema.js';
import { loadConfig } from '../config/loader.js';
import { ServiceRegistry, createRegistry } from '../registry/registry.js';
import { ServiceIdentity, createServiceIdentity } from '../identity/service-identity.js';
import { AuthorizationPolicy, createAuthorizationPolicy } from '../identity/authorization.js';

export interface MicroserviceApp {
  readonly service: ServiceConfig;
  readonly config: MicroserviceConfig;
  readonly registry: ServiceRegistry;
  readonly identity: ServiceIdentity;
  readonly authorization: AuthorizationPolicy;
  readonly lifecycle: LifecycleManager;

  start(): Promise<void>;
  stop(): Promise<void>;
  getTransport(name: string): Transport | undefined;
  registerTransport(transport: Transport): void;
  unregisterTransport(name: string): boolean;
}

export interface CreateAppOptions {
  configPath?: string;
  config?: Partial<MicroserviceConfig>;
}

export async function createMicroservice(options: CreateAppOptions = {}): Promise<MicroserviceApp> {
  const config = options.configPath 
    ? loadConfig(options.configPath)
    : loadConfig();

  if (options.config) {
    Object.assign(config, options.config);
  }

  const identity = createServiceIdentity(config.service);
  const registry = createRegistry(config.registry);
  const authorization = createAuthorizationPolicy(config.auth.type, {
    entries: config.auth.entries,
    defaultPolicy: config.auth.defaultPolicy,
    roles: config.auth.roles,
    serviceRoles: config.auth.serviceRoles,
  });
  const lifecycle = new LifecycleManager(config.registry.healthCheckIntervalMs || 30000);

  const app: MicroserviceApp = {
    service: config.service,
    config,
    registry,
    identity,
    authorization,
    lifecycle,

    start: async () => {
      await registry.register(identity.getRegistration());
      lifecycle.setHooks({
        onStop: async () => {
          await registry.deregister(identity.serviceId);
        },
      });
      await lifecycle.start();
    },

    stop: async () => {
      await lifecycle.stop();
    },

    getTransport: (name: string) => {
      return lifecycle.getTransport(name);
    },

    registerTransport: (transport: Transport) => {
      lifecycle.registerTransport(transport);
    },

    unregisterTransport: (name: string) => {
      return lifecycle.unregisterTransport(name);
    },
  };

  return app;
}

export type { MicroserviceConfig, ServiceConfig } from '../config/schema.js';
export { loadConfig } from '../config/loader.js';