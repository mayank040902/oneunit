import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMetricsCollector, createMetricsCollector } from '../../src/observability/metrics.js';

function findMetric(metrics: any[], name: string, labels: Record<string, string>): any {
  return metrics.find(
    (m) => m.type === 'counter' && m.name === name && JSON.stringify(m.labels) === JSON.stringify(labels),
  );
}

describe('InMemoryMetricsCollector', () => {
  let collector: InMemoryMetricsCollector;

  beforeEach(() => {
    collector = new InMemoryMetricsCollector();
  });

  it('should start with no metrics', () => {
    expect(collector.getMetrics()).toEqual([]);
  });

  it('should increment a counter and track the cumulative value', () => {
    collector.incrementCounter('requests', { method: 'GET' });
    collector.incrementCounter('requests', { method: 'GET' });
    collector.incrementCounter('requests', { method: 'GET' }, 5);

    const metrics = collector.getMetrics();
    const snapshot = findMetric(metrics, 'requests', { method: 'GET' });
    expect(snapshot).toBeDefined();
    expect(snapshot!.value).toBe(7);
    expect(snapshot!.type).toBe('counter');
    expect(snapshot!.labels).toEqual({ method: 'GET' });
  });

  it('should default counter increment to 1', () => {
    collector.incrementCounter('c');
    const metrics = collector.getMetrics();
    const snapshot = metrics.find((m) => m.type === 'counter');
    expect(snapshot!.value).toBe(1);
  });

  it('should track separate counters by label set', () => {
    collector.incrementCounter('requests', { method: 'GET' });
    collector.incrementCounter('requests', { method: 'POST' });

    const metrics = collector.getMetrics();
    const counters = metrics.filter((m) => m.type === 'counter' && m.name === 'requests');
    expect(counters.length).toBe(2);
    expect(counters.map((m) => m.labels)).toEqual(
      expect.arrayContaining([{ method: 'GET' }, { method: 'POST' }]),
    );
  });

  it('should produce exactly one series per (name, labels) combination', () => {
    collector.incrementCounter('requests', { method: 'GET' });
    collector.incrementCounter('requests', { method: 'GET' });
    collector.incrementCounter('requests', { method: 'GET' });

    const metrics = collector.getMetrics();
    const requests = metrics.filter((m) => m.name === 'requests');
    expect(requests.length).toBe(1);
    expect(requests[0].value).toBe(3);
  });

  it('should not label-encode metric names', () => {
    collector.incrementCounter('requests', { method: 'GET' });
    const metrics = collector.getMetrics();
    const names = new Set(metrics.map((m) => m.name));
    expect(names.has('requests')).toBe(true);
    for (const name of names) {
      expect(name).not.toMatch(/\{.*\}/);
    }
  });

  it('should set a gauge value', () => {
    collector.setGauge('temperature', 42, { zone: 'a' });
    const metrics = collector.getMetrics();
    const snapshot = metrics.find((m) => m.type === 'gauge');
    expect(snapshot).toBeDefined();
    expect(snapshot!.value).toBe(42);
    expect(snapshot!.labels).toEqual({ zone: 'a' });
  });

  it('should overwrite gauge values (last write wins)', () => {
    collector.setGauge('g', 1);
    collector.setGauge('g', 2);
    const metrics = collector.getMetrics();
    const gauges = metrics.filter((m) => m.type === 'gauge' && m.name === 'g');
    expect(gauges.length).toBe(1);
    expect(gauges[0].value).toBe(2);
  });

  it('should record histograms', () => {
    collector.recordHistogram('latency', 100, { op: 'read' });
    const metrics = collector.getMetrics();
    const latest = metrics.find((m) => m.type === 'histogram');
    expect(latest!.type).toBe('histogram');
    expect(latest!.value).toBe(100);
    expect(latest!.labels).toEqual({ op: 'read' });
  });

  it('should record summaries', () => {
    collector.recordSummary('size', 512);
    const metrics = collector.getMetrics();
    const latest = metrics.find((m) => m.type === 'summary');
    expect(latest!.type).toBe('summary');
    expect(latest!.value).toBe(512);
  });

  it('should reset all state', () => {
    collector.incrementCounter('c');
    collector.setGauge('g', 1);
    collector.recordHistogram('h', 1);
    collector.recordSummary('s', 1);

    collector.reset();
    expect(collector.getMetrics()).toEqual([]);
  });

  it('should enforce cardinality limit on unique series', () => {
    const bounded = new InMemoryMetricsCollector(2);
    bounded.incrementCounter('c', { a: '1' });
    bounded.incrementCounter('c', { a: '2' });

    expect(() => bounded.incrementCounter('c', { a: '3' })).toThrow(
      /cardinality limit/,
    );
  });

  it('should redact sensitive labels', () => {
    collector.incrementCounter('c', { user_id: '123', method: 'GET' });
    const metrics = collector.getMetrics();
    const c = metrics.find((m) => m.name === 'c');
    expect(c!.labels).not.toHaveProperty('user_id');
    expect(c!.labels).toEqual({ method: 'GET' });
  });

  it('should produce a timestamp on every metric', () => {
    collector.incrementCounter('c');
    const metrics = collector.getMetrics();
    expect(typeof metrics[0].timestamp).toBe('number');
    expect(metrics[0].timestamp).toBeLessThanOrEqual(Date.now());
  });

  it('should export valid Prometheus text exposition format', () => {
    collector.incrementCounter('requests', { method: 'GET' }, 5);
    collector.setGauge('temperature', 42, { zone: 'a' });

    const output = collector.toPrometheus();
    expect(output).toContain('# HELP requests');
    expect(output).toContain('# TYPE requests counter');
    expect(output).toContain('# HELP temperature');
    expect(output).toContain('# TYPE temperature gauge');
    expect(output).toContain('requests{method="GET"} 5 ');
    expect(output).toContain('temperature{zone="a"} 42 ');
  });

  it('should escape special characters in Prometheus output', () => {
    collector.incrementCounter('c', { label: 'a"b\\c' });
    const output = collector.toPrometheus();
    expect(output).toContain('label="a\\"b\\\\c"');
  });

  it('should not duplicate HELP/TYPE lines for the same metric name', () => {
    collector.incrementCounter('requests', { method: 'GET' });
    collector.incrementCounter('requests', { method: 'POST' });
    const output = collector.toPrometheus();
    const helpCount = (output.match(/# HELP requests/g) ?? []).length;
    const typeCount = (output.match(/# TYPE requests/g) ?? []).length;
    expect(helpCount).toBe(1);
    expect(typeCount).toBe(1);
  });
});

describe('createMetricsCollector', () => {
  it('should return an InMemoryMetricsCollector', () => {
    const collector = createMetricsCollector();
    expect(collector).toBeInstanceOf(InMemoryMetricsCollector);
  });

  it('should accept cardinality limits', () => {
    const collector = createMetricsCollector(5);
    expect(collector).toBeInstanceOf(InMemoryMetricsCollector);
  });
});
