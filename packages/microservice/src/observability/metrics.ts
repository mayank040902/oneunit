export interface Metric {
  name: string;
  value: number;
  timestamp: number;
  labels: Record<string, string>;
  type: 'counter' | 'gauge' | 'histogram' | 'summary';
}

export interface MetricsCollector {
  incrementCounter(name: string, labels?: Record<string, string>, value?: number): void;
  setGauge(name: string, value: number, labels?: Record<string, string>): void;
  recordHistogram(name: string, value: number, labels?: Record<string, string>): void;
  recordSummary(name: string, value: number, labels?: Record<string, string>): void;
  getMetrics(): Metric[];
  reset(): void;
}

export class InMemoryMetricsCollector implements MetricsCollector {
  private metrics: Map<string, Metric[]> = new Map();
  private counters: Map<string, number> = new Map();
  private gauges: Map<string, number> = new Map();

  incrementCounter(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = this.getKey(name, labels);
    const current = this.counters.get(key) ?? 0;
    this.counters.set(key, current + value);
    
    this.addMetric({
      name,
      value: current + value,
      timestamp: Date.now(),
      labels,
      type: 'counter',
    });
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.getKey(name, labels);
    this.gauges.set(key, value);
    
    this.addMetric({
      name,
      value,
      timestamp: Date.now(),
      labels,
      type: 'gauge',
    });
  }

  recordHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
    this.addMetric({
      name,
      value,
      timestamp: Date.now(),
      labels,
      type: 'histogram',
    });
  }

  recordSummary(name: string, value: number, labels: Record<string, string> = {}): void {
    this.addMetric({
      name,
      value,
      timestamp: Date.now(),
      labels,
      type: 'summary',
    });
  }

  getMetrics(): Metric[] {
    const allMetrics: Metric[] = [];
    
    for (const [key, metrics] of this.metrics) {
      allMetrics.push(...metrics);
    }
    
    for (const [key, value] of this.counters) {
      allMetrics.push({
        name: key,
        value,
        timestamp: Date.now(),
        labels: {},
        type: 'counter',
      });
    }
    
    for (const [key, value] of this.gauges) {
      allMetrics.push({
        name: key,
        value,
        timestamp: Date.now(),
        labels: {},
        type: 'gauge',
      });
    }
    
    return allMetrics;
  }

  reset(): void {
    this.metrics.clear();
    this.counters.clear();
    this.gauges.clear();
  }

  private getKey(name: string, labels: Record<string, string>): string {
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    return labelStr ? `${name}{${labelStr}}` : name;
  }

  private addMetric(metric: Metric): void {
    const key = metric.name;
    if (!this.metrics.has(key)) {
      this.metrics.set(key, []);
    }
    const arr = this.metrics.get(key)!;
    arr.push(metric);
    
    if (arr.length > 1000) {
      arr.shift();
    }
  }
}

export function createMetricsCollector(): MetricsCollector {
  return new InMemoryMetricsCollector();
}