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
  toPrometheus(): string;
}

const DEFAULT_MAX_SERIES = 1000;
const DEFAULT_MAX_SAMPLES_PER_SERIES = 1000;

// Label keys that must never be exported as Prometheus labels.
const SENSITIVE_LABEL_KEYS = new Set([
  'user_id',
  'userid',
  'password',
  'token',
  'secret',
  'api_key',
  'apikey',
  'credential',
  'authorization',
  'cookie',
  'session',
]);

function isSensitiveLabel(key: string): boolean {
  return SENSITIVE_LABEL_KEYS.has(key.toLowerCase());
}

function sanitizeLabels(labels: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (isSensitiveLabel(key)) continue;
    result[key] = String(value);
  }
  return result;
}

function serializeLabels(labels: Record<string, string>): string {
  const entries = Object.entries(sanitizeLabels(labels)).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${escapePrometheusLabel(k)}=${escapePrometheusLabelValue(v)}`).join(',');
}

function escapePrometheusLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function escapePrometheusLabelValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

export class InMemoryMetricsCollector implements MetricsCollector {
  // Outer key: metric name. Inner key: serialized labels. One series per
  // (name, labels) combination — no duplicates, no label-encoded names.
  private series: Map<string, Map<string, Metric>> = new Map();
  private maxSeries: number;
  private maxSamplesPerSeries: number;

  constructor(maxSeries = DEFAULT_MAX_SERIES, maxSamplesPerSeries = DEFAULT_MAX_SAMPLES_PER_SERIES) {
    this.maxSeries = maxSeries;
    this.maxSamplesPerSeries = maxSamplesPerSeries;
  }

  incrementCounter(name: string, labels: Record<string, string> = {}, value = 1): void {
    const cleanLabels = sanitizeLabels(labels);
    const labelKey = serializeLabels(cleanLabels);
    const seriesMap = this.getOrCreateSeriesMap(name);

    if (!seriesMap.has(labelKey) && seriesMap.size >= this.maxSeries) {
      throw new Error(`Metric cardinality limit reached: max ${this.maxSeries} series`);
    }

    const existing = seriesMap.get(labelKey);
    const newValue = (existing?.value ?? 0) + value;
    const metric: Metric = {
      name,
      value: newValue,
      timestamp: Date.now(),
      labels: cleanLabels,
      type: 'counter',
    };
    seriesMap.set(labelKey, metric);
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const cleanLabels = sanitizeLabels(labels);
    const labelKey = serializeLabels(cleanLabels);
    const seriesMap = this.getOrCreateSeriesMap(name);

    if (!seriesMap.has(labelKey) && seriesMap.size >= this.maxSeries) {
      throw new Error(`Metric cardinality limit reached: max ${this.maxSeries} series`);
    }

    const metric: Metric = {
      name,
      value,
      timestamp: Date.now(),
      labels: cleanLabels,
      type: 'gauge',
    };
    seriesMap.set(labelKey, metric);
  }

  recordHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
    const cleanLabels = sanitizeLabels(labels);
    const labelKey = serializeLabels(cleanLabels);
    const seriesMap = this.getOrCreateSeriesMap(name);

    if (!seriesMap.has(labelKey) && seriesMap.size >= this.maxSeries) {
      throw new Error(`Metric cardinality limit reached: max ${this.maxSeries} series`);
    }

    const metric: Metric = {
      name,
      value,
      timestamp: Date.now(),
      labels: cleanLabels,
      type: 'histogram',
    };
    seriesMap.set(labelKey, metric);
  }

  recordSummary(name: string, value: number, labels: Record<string, string> = {}): void {
    const cleanLabels = sanitizeLabels(labels);
    const labelKey = serializeLabels(cleanLabels);
    const seriesMap = this.getOrCreateSeriesMap(name);

    if (!seriesMap.has(labelKey) && seriesMap.size >= this.maxSeries) {
      throw new Error(`Metric cardinality limit reached: max ${this.maxSeries} series`);
    }

    const metric: Metric = {
      name,
      value,
      timestamp: Date.now(),
      labels: cleanLabels,
      type: 'summary',
    };
    seriesMap.set(labelKey, metric);
  }

  getMetrics(): Metric[] {
    const allMetrics: Metric[] = [];
    for (const seriesMap of this.series.values()) {
      for (const [, metric] of seriesMap) {
        allMetrics.push({ ...metric });
      }
    }
    return allMetrics;
  }

  reset(): void {
    this.series.clear();
  }

  toPrometheus(): string {
    const lines: string[] = [];
    const emitted = new Set<string>();

    for (const [name, seriesMap] of this.series) {
      // HELP line
      const helpKey = `# HELP ${name}`;
      if (!emitted.has(helpKey)) {
        lines.push(helpKey);
        emitted.add(helpKey);
      }
      // TYPE line (use the type of the first series for this name)
      const firstMetric = seriesMap.values().next().value;
      if (firstMetric) {
        const typeKey = `# TYPE ${name} ${firstMetric.type}`;
        if (!emitted.has(typeKey)) {
          lines.push(typeKey);
          emitted.add(typeKey);
        }
      }

      for (const [, metric] of seriesMap) {
        const labelsStr = serializeLabels(metric.labels);
        const labelSuffix = labelsStr ? `{${labelsStr}}` : '';
        lines.push(`${name}${labelSuffix} ${metric.value} ${metric.timestamp}`);
      }
    }

    return lines.join('\n') + (lines.length > 0 ? '\n' : '');
  }

  private getOrCreateSeriesMap(name: string): Map<string, Metric> {
    if (!this.series.has(name)) {
      this.series.set(name, new Map());
    }
    return this.series.get(name)!;
  }
}

export function createMetricsCollector(maxSeries?: number, maxSamplesPerSeries?: number): MetricsCollector {
  return new InMemoryMetricsCollector(maxSeries, maxSamplesPerSeries);
}
