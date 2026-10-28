 
import type { AdaptiveThrottlingOptions } from "./types.js";

export class AdaptiveThrottler {
  private current: number;
  private lastSignal = Date.now();
  constructor(private readonly baseLimit: number, private readonly options: AdaptiveThrottlingOptions) {
    this.current = baseLimit;
    if (options.minLimit > options.maxLimit) throw new Error("minLimit must be <= maxLimit");
    if (!Number.isFinite(baseLimit) || baseLimit <= 0) throw new Error("baseLimit must be positive finite");
  }
  sample(load: number, nowMs: number = Date.now()): number {
    if (!Number.isFinite(load)) return this.current;
    const sampling = this.options.samplingIntervalMs ?? 1000;
    if (sampling > 0 && nowMs - this.lastSignal < sampling) return this.current;
    this.lastSignal = nowMs;
    const min = this.options.minLimit;
    const max = this.options.maxLimit;
    const step = this.options.maxAdjustmentPerStep ?? 1;
    const hyst = this.options.hysteresis ?? 0.1;
    const recovery = this.options.recoveryStep ?? 1;
    const safeLoad = Math.min(1, Math.max(0, load));
    let target = this.current;
    if (safeLoad > 0.8) target = this.current - step;
    else if (safeLoad < 0.4 + hyst) target = this.current + recovery;
    // no change in mid-band to avoid oscillation
    target = Math.max(min, Math.min(max, target));
    this.current = target;
    return this.current;
  }
  getLimit(): number {
    return this.current;
  }
  reset(): void {
    this.current = this.baseLimit;
    this.lastSignal = Date.now();
  }
}

export function createAdaptiveThrottler(baseLimit: number, options: AdaptiveThrottlingOptions): AdaptiveThrottler {
  return new AdaptiveThrottler(baseLimit, options);
}
