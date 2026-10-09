import { KeyProvider, ServiceKeys } from './key-provider.js';

export interface KeyRotationPolicy {
  intervalMs: number;
  gracePeriodMs: number;
  maxVersions: number;
  autoRotate: boolean;
}

export interface KeyRotationEvent {
  serviceId: string;
  oldVersion: number;
  newVersion: number;
  rotatedAt: number;
}

export type KeyRotationListener = (event: KeyRotationEvent) => void;

export class KeyRotationManager {
  private provider: KeyProvider;
  private policy: KeyRotationPolicy;
  private listeners: KeyRotationListener[] = [];
  private rotationTimers: Map<string, NodeJS.Timeout> = new Map();
  private running = false;

  constructor(provider: KeyProvider, policy: KeyRotationPolicy) {
    this.provider = provider;
    this.policy = policy;
  }

  addListener(listener: KeyRotationListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: KeyRotationListener): void {
    const index = this.listeners.indexOf(listener);
    if (index >= 0) this.listeners.splice(index, 1);
  }

  start(serviceId: string): void {
    if (this.rotationTimers.has(serviceId)) return;

    const timer = setInterval(async () => {
      try {
        await this.rotate(serviceId);
      } catch (err) {
        console.error(`Key rotation failed for ${serviceId}:`, err);
      }
    }, this.policy.intervalMs);

    this.rotationTimers.set(serviceId, timer);
    this.running = true;
  }

  stop(serviceId: string): void {
    const timer = this.rotationTimers.get(serviceId);
    if (timer) {
      clearInterval(timer);
      this.rotationTimers.delete(serviceId);
    }
    if (this.rotationTimers.size === 0) {
      this.running = false;
    }
  }

  async rotate(serviceId: string): Promise<ServiceKeys> {
    const oldVersion = await this.provider.getKeyVersion(serviceId);

    const newKeys = await this.provider.rotateKeys(serviceId);

    const event: KeyRotationEvent = {
      serviceId,
      oldVersion,
      newVersion: newKeys.version,
      rotatedAt: Date.now(),
    };

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('Key rotation listener error:', err);
      }
    }

    return newKeys;
  }

  async rotateAll(): Promise<Map<string, ServiceKeys>> {
    const results = new Map<string, ServiceKeys>();
    
    for (const serviceId of this.rotationTimers.keys()) {
      try {
        const keys = await this.rotate(serviceId);
        results.set(serviceId, keys);
      } catch (err) {
        console.error(`Failed to rotate keys for ${serviceId}:`, err);
      }
    }

    return results;
  }

  isRunning(): boolean {
    return this.running;
  }

  getPolicy(): KeyRotationPolicy {
    return { ...this.policy };
  }

  setPolicy(policy: Partial<KeyRotationPolicy>): void {
    this.policy = { ...this.policy, ...policy };
  }
}

export function createKeyRotationManager(
  provider: KeyProvider,
  policy: Partial<KeyRotationPolicy> = {}
): KeyRotationManager {
  const defaultPolicy: KeyRotationPolicy = {
    intervalMs: 24 * 60 * 60 * 1000,
    gracePeriodMs: 60 * 60 * 1000,
    maxVersions: 3,
    autoRotate: true,
  };
  
  return new KeyRotationManager(provider, { ...defaultPolicy, ...policy });
}