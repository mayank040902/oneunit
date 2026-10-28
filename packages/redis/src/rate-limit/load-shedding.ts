 
export interface LoadSheddingDecision { shed: boolean; reason: string | null; priority: number; }
export class LoadShedder {
  private inFlight = 0;
  constructor(private readonly maxInFlight: number, private readonly queueThreshold: number = 100) {}
  acquire(priority: number = 0): LoadSheddingDecision {
    if (priority < 0) priority = 0;
    // shed low priority when overloaded
    if (this.inFlight >= this.maxInFlight) {
      if (priority < 5) {
        return { shed: true, reason: "overloaded", priority };
      }
    }
    this.inFlight += 1;
    return { shed: false, reason: null, priority };
  }
  release(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
  }
  getInFlight(): number { return this.inFlight; }
}
export function createLoadShedder(maxInFlight: number, queueThreshold?: number): LoadShedder {
  return new LoadShedder(maxInFlight, queueThreshold);
}
