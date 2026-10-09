import { HealthCheck, ServiceInstance } from '../contracts/schemas.js';
import { ServiceRegistry } from './registry.js';

export interface HealthCheckResult {
  serviceId: string;
  instanceId: string;
  status: ServiceInstance['status'];
  checkedAt: number;
  details?: Record<string, unknown>;
}

export interface HealthChecker {
  check(serviceId: string, instanceId: string): Promise<HealthCheckResult>;
  checkAll(): Promise<HealthCheckResult[]>;
}

export class DefaultHealthChecker implements HealthChecker {
  private registry: ServiceRegistry;
  private checkers: Map<string, () => Promise<HealthCheckResult>> = new Map();

  constructor(registry: ServiceRegistry) {
    this.registry = registry;
  }

  registerChecker(serviceId: string, checker: () => Promise<HealthCheckResult>): void {
    this.checkers.set(serviceId, checker);
  }

  async check(serviceId: string, instanceId: string): Promise<HealthCheckResult> {
    const checker = this.checkers.get(serviceId);
    
    if (checker) {
      return checker();
    }

    const instances = await this.registry.discover({ serviceId, limit: 10 });
    const instance = instances.find(i => i.instanceId === instanceId);
    
    if (!instance) {
      return {
        serviceId,
        instanceId,
        status: 'unhealthy',
        checkedAt: Date.now(),
        details: { error: 'Instance not found' },
      };
    }

    const timeSinceHeartbeat = Date.now() - instance.lastHeartbeat;
    const healthy = timeSinceHeartbeat < 60000;

    return {
      serviceId,
      instanceId,
      status: healthy ? 'healthy' : 'degraded',
      checkedAt: Date.now(),
      details: { timeSinceHeartbeat },
    };
  }

  async checkAll(): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = [];
    
    for (const [serviceId, checker] of this.checkers.entries()) {
      try {
        const result = await checker();
        results.push(result);
      } catch (err) {
        results.push({
          serviceId,
          instanceId: 'unknown',
          status: 'unhealthy',
          checkedAt: Date.now(),
          details: { error: (err as Error).message },
        });
      }
    }

    return results;
  }
}

export function createHealthChecker(registry: ServiceRegistry): HealthChecker {
  return new DefaultHealthChecker(registry);
}