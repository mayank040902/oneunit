import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryMetricsCollector, createMetricsCollector } from '../../src/observability/metrics.js';
import { Metric } from '../../src/observability/metrics.js';

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
    // The counter snapshot carries the cumulative value.
    const snapshot = metrics.find(
      (m) => m.type === 'counter' && m.name === 'requests{method="GET"}',
    );
    expect(snapshot).toBeDefined();
    expect(snapshot!.value).toBe(7);
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
    const names = metrics
      .filter((m) => m.type === 'counter')
      .map((m) => m.name);
    expect(names).toContain('requests{method="GET"}');
    expect(names).toContain('requests{method="POST"}');
  });

  it('should record a per-call metric with the supplied labels', () => {
    collector.incrementCounter('requests', { method: 'GET' });
    const metrics = collector.getMetrics();
    const withLabels = metrics.filter((m) => Object.keys(m.labels).length > 0);
    expect(withLabels.length).toBeGreaterThan(0);
    expect(withLabels[0].labels).toEqual({ method: 'GET' });
  });

  it('should set a gauge value', () => {
    collector.setGauge('temperature', 42, { zone: 'a' });
    const metrics = collector.getMetrics();
    const snapshot = metrics.find((m) => m.type === 'gauge');
    expect(snapshot).toBeDefined();
    expect(snapshot!.value).toBe(42);
  });

  it('should overwrite gauge values', () => {
    collector.setGauge('g', 1);
    collector.setGauge('g', 2);
    const metrics = collector.getMetrics();
    const gauges = metrics.filter((m) => m.type === 'gauge' && m.name === 'g');
    const latest = gauges[gauges.length - 1];
    expect(latest.value).toBe(2);
  });

  it('should record histograms', () => {
    collector.recordHistogram('latency', 100, { op: 'read' });
    const metrics = collector.getMetrics();
    const latest = metrics[metrics.length - 1];
    expect(latest.type).toBe('histogram');
    expect(latest.value).toBe(100);
  });

  it('should record summaries', () => {
    collector.recordSummary('size', 512);
    const metrics = collector.getMetrics();
    const latest = metrics[metrics.length - 1];
    expect(latest.type).toBe('summary');
    expect(latest.value).toBe(512);
  });

  it('should reset all state', () => {
    collector.incrementCounter('c');
    collector.setGauge('g', 1);
    collector.recordHistogram('h', 1);
    collector.recordSummary('s', 1);

    collector.reset();
    expect(collector.getMetrics()).toEqual([]);
  });

  it('should bound the per-name metric history', () => {
    for (let i = 0; i < 1005; i++) {
      collector.incrementCounter('c');
    }
    const metrics = collector.getMetrics();
    // Bounded per-name history (1000) plus the counter snapshot.
    expect(metrics.length).toBeLessThanOrEqual(1001);
  });

  it('should produce a timestamp on every metric', () => {
    collector.incrementCounter('c');
    const metrics = collector.getMetrics();
    expect(typeof metrics[0].timestamp).toBe('number');
    expect(metrics[0].timestamp).toBeLessThanOrEqual(Date.now());
  });
});

describe('createMetricsCollector', () => {
  it('should return an InMemoryMetricsCollector', () => {
    const collector = createMetricsCollector();
    expect(collector).toBeInstanceOf(InMemoryMetricsCollector);
  });
});

describe('Metric type shape', () => {
  it('supports all four metric types', () => {
    const counter: Metric = {
      name: 'c',
      value: 1,
      timestamp: Date.now(),
      labels: {},
      type: 'counter',
    };
    const gauge: Metric = { ...counter, type: 'gauge' };
    const histogram: Metric = { ...counter, type: 'histogram' };
    const summary: Metric = { ...counter, type: 'summary' };

    expect(counter.type).toBe('counter');
    expect(gauge.type).toBe('gauge');
    expect(histogram.type).toBe('histogram');
    expect(summary.type).toBe('summary');
  });
});