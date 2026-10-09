import { ServiceInstance, ServiceQuery } from '../contracts/schemas.js';
import { ServiceRegistry } from './registry.js';

export interface DiscoveryOptions {
  cacheTtlMs: number;
  maxCacheSize: number;
}

export interface DiscoveryResult {
  instances: ServiceInstance[];
  fromCache: boolean;
  timestamp: number;
}

export class ServiceDiscovery {
  private registry: ServiceRegistry;
  private cache: Map<string, DiscoveryResult> = new Map();
  private options: DiscoveryOptions;

  constructor(registry: ServiceRegistry, options: DiscoveryOptions = { cacheTtlMs: 5000, maxCacheSize: 100 }) {
    this.registry = registry;
    this.options = options;
  }

  async discover(query: ServiceQuery): Promise<DiscoveryResult> {
    const cacheKey = JSON.stringify(query);
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.options.cacheTtlMs) {
      return { ...cached, fromCache: true };
    }

    const instances = await this.registry.discover(query);
    
    const result: DiscoveryResult = {
      instances,
      fromCache: false,
      timestamp: Date.now(),
    };

    if (this.cache.size >= this.options.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    
    this.cache.set(cacheKey, result);
    return result;
  }

  async getInstance(serviceId: string, instanceId: string): Promise<ServiceInstance | null> {
    const result = await this.discover({ serviceId, limit: 100 });
    return result.instances.find(i => i.instanceId === instanceId) ?? null;
  }

  async getHealthyInstances(serviceId: string): Promise<ServiceInstance[]> {
    const result = await this.discover({ serviceId, status: 'healthy', limit: 100 });
    return result.instances;
  }

  invalidateCache(query?: ServiceQuery): void {
    if (query) {
      this.cache.delete(JSON.stringify(query));
    } else {
      this.cache.clear();
    }
  }

  getCacheStats(): { size: number; maxSize: number } {
    return { size: this.cache.size, maxSize: this.options.maxCacheSize };
  }
}

export function createDiscovery(registry: ServiceRegistry, options?: DiscoveryOptions): ServiceDiscovery {
  return new ServiceDiscovery(registry, options);
}