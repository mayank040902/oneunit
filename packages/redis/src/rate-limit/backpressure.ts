 
export interface BackpressureDecision { admitted: boolean; waitMs: number; reason: string | null; }
export class BackpressureController {
  private pending = 0;
  constructor(private readonly maxPending: number, private readonly maxWaitMs: number = 1000) {
    if (!Number.isFinite(maxPending) || maxPending <= 0) throw new Error("maxPending must be positive");
  }
  async admit(weight: number = 1, waitFn?: (ms: number) => Promise<void>): Promise<BackpressureDecision> {
    if (!Number.isFinite(weight) || weight <= 0) throw new Error("weight must be positive");
    const start = Date.now();
    while (this.pending + weight > this.maxPending) {
      const elapsed = Date.now() - start;
      if (elapsed >= this.maxWaitMs) {
        return { admitted: false, waitMs: elapsed, reason: "backpressure" };
      }
      if (!waitFn) {
        return { admitted: false, waitMs: elapsed, reason: "backpressure" };
      }
      const remaining = this.maxWaitMs - elapsed;
      await waitFn(Math.max(1, Math.min(remaining, this.maxWaitMs)));
      if (Date.now() - start >= this.maxWaitMs) {
        return { admitted: false, waitMs: Date.now() - start, reason: "backpressure" };
      }
    }
    this.pending += weight;
    return { admitted: true, waitMs: Date.now() - start, reason: null };
  }
  release(weight: number = 1): void {
    this.pending = Math.max(0, this.pending - weight);
  }
  getPending(): number { return this.pending; }
  reset(): void { this.pending = 0; }
}
export function createBackpressureController(maxPending: number, maxWaitMs?: number): BackpressureController {
  return new BackpressureController(maxPending, maxWaitMs);
}
