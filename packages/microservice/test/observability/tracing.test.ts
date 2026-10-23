import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryTracer, NoopTracer, createTracer, extractTraceContext, injectTraceContext } from '../../src/observability/tracing.js';
import { SpanContext } from '../../src/observability/tracing.js';

describe('NoopTracer', () => {
  const tracer = new NoopTracer();

  it('should create a span with empty trace context', () => {
    const span = tracer.startSpan('op');
    expect(span.context.traceId).toBe('');
    expect(span.context.spanId).toBe('');
    expect(span.name).toBe('op');
    expect(span.status.code).toBe('unset');
  });

  it('should accept attributes', () => {
    const span = tracer.startSpan('op', { attributes: { kind: 'rpc' } });
    expect(span.attributes).toEqual({ kind: 'rpc' });
  });

  it('should not track current span', () => {
    expect(tracer.getCurrentSpan()).toBeNull();
  });

  it('should be a no-op on endSpan', () => {
    const span = tracer.startSpan('op');
    expect(() => tracer.endSpan(span)).not.toThrow();
  });
});

describe('InMemoryTracer', () => {
  let tracer: InMemoryTracer;

  beforeEach(() => {
    tracer = new InMemoryTracer();
    tracer.clear();
  });

  it('should generate a traceId and spanId', () => {
    const span = tracer.startSpan('op');
    expect(span.context.traceId).not.toBe('');
    expect(span.context.spanId).not.toBe('');
    expect(span.context.traceFlags).toBe(1);
  });

  it('should set the current span within runWithSpan', async () => {
    const span = tracer.startSpan('op');
    await tracer.runWithSpan(span, () => {
      expect(tracer.getCurrentSpan()).toBe(span);
    });
  });

  it('should not have a current span outside runWithSpan', () => {
    tracer.startSpan('op');
    expect(tracer.getCurrentSpan()).toBeNull();
  });

  it('should clear the current span after runWithSpan completes', async () => {
    const span = tracer.startSpan('op');
    await tracer.runWithSpan(span, () => {
      expect(tracer.getCurrentSpan()).toBe(span);
    });
    expect(tracer.getCurrentSpan()).toBeNull();
  });

  it('should inherit the parent traceId', async () => {
    const parent = tracer.startSpan('parent');
    const child = await tracer.runWithSpan(parent, () =>
      tracer.startSpan('child')
    );
    expect(child.context.traceId).toBe(parent.context.traceId);
    expect(child.context.parentSpanId).toBe(parent.context.spanId);
  });

  it('should inherit the current span as parent by default within runWithSpan', async () => {
    const parent = tracer.startSpan('parent');
    const child = await tracer.runWithSpan(parent, () =>
      tracer.startSpan('child')
    );
    expect(child.context.parentSpanId).toBe(parent.context.spanId);
    expect(child.context.traceId).toBe(parent.context.traceId);
  });

  it('should record ended spans', () => {
    const span = tracer.startSpan('op');
    tracer.endSpan(span);
    expect(tracer.getSpans()).toEqual([span]);
    expect(span.endTime).toBeDefined();
  });

  it('should filter spans by traceId', () => {
    const a = tracer.startSpan('a');
    tracer.endSpan(a);
    // Start a new trace by ending the current and starting fresh.
    const b = tracer.startSpan('b');
    b.context.traceId = 'trace-xyz';
    tracer.endSpan(b);
    const spans = tracer.getSpansByTraceId('trace-xyz');
    expect(spans.length).toBe(1);
    expect(spans[0].name).toBe('b');
  });

  it('should clear all spans and current span', () => {
    const span = tracer.startSpan('op');
    tracer.endSpan(span);
    expect(tracer.getSpans()).toHaveLength(1);

    tracer.startSpan('op-2');
    expect(tracer.getSpans()).toHaveLength(2);

    tracer.clear();
    expect(tracer.getSpans()).toEqual([]);
    expect(tracer.getCurrentSpan()).toBeNull();
  });

  it('should set status on end', () => {
    const span = tracer.startSpan('op');
    span.status = { code: 'error', message: 'boom' };
    tracer.endSpan(span);
    const spans = tracer.getSpans();
    expect(spans[0].status.code).toBe('error');
  });
});

describe('createTracer', () => {
  it('should create a NoopTracer by default', () => {
    expect(createTracer()).toBeInstanceOf(NoopTracer);
  });

  it('should create an InMemoryTracer for memory type', () => {
    expect(createTracer('memory')).toBeInstanceOf(InMemoryTracer);
  });
});

describe('extractTraceContext', () => {
  it('should return null when no trace headers are present', () => {
    expect(extractTraceContext({})).toBeNull();
  });

  it('should extract from traceparent', () => {
    const headers = { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' };
    const context = extractTraceContext(headers);
    expect(context).not.toBeNull();
    expect(context!.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(context!.spanId).toBe('b7ad6b7169203331');
  });

  it('should fall back to x-trace-id / x-span-id', () => {
    const context = extractTraceContext({ 'x-trace-id': 't1', 'x-span-id': 's1' });
    expect(context).toEqual({ traceId: 't1', spanId: 's1', parentSpanId: undefined, traceFlags: 1 });
  });

  it('should include parentSpanId when present', () => {
    const context = extractTraceContext({
      'x-trace-id': 't1',
      'x-span-id': 's1',
      'x-parent-span-id': 'p1',
    });
    expect(context!.parentSpanId).toBe('p1');
  });
});

describe('injectTraceContext', () => {
  it('should write traceparent and x-* headers', () => {
    const headers: Record<string, string> = {};
    const context: SpanContext = {
      traceId: 'trace-1',
      spanId: 'span-1',
      parentSpanId: 'parent-1',
    };
    injectTraceContext(context, headers);
    expect(headers.traceparent).toBe('00-trace-1-span-1-01');
    expect(headers['x-trace-id']).toBe('trace-1');
    expect(headers['x-span-id']).toBe('span-1');
    expect(headers['x-parent-span-id']).toBe('parent-1');
  });

  it('should not write x-parent-span-id when absent', () => {
    const headers: Record<string, string> = {};
    injectTraceContext({ traceId: 't', spanId: 's' }, headers);
    expect(headers['x-parent-span-id']).toBeUndefined();
  });

  it('should honor traceFlags when injecting instead of hardcoding sampled', () => {
    const headers: Record<string, string> = {};
    injectTraceContext({ traceId: 't', spanId: 's', traceFlags: 0 }, headers);
    expect(headers.traceparent).toBe('00-t-s-00');

    const headers2: Record<string, string> = {};
    injectTraceContext({ traceId: 't', spanId: 's', traceFlags: 1 }, headers2);
    expect(headers2.traceparent).toBe('00-t-s-01');
  });
});

describe('InMemoryTracer concurrent async context', () => {
  let tracer: InMemoryTracer;

  beforeEach(() => {
    tracer = new InMemoryTracer();
    tracer.clear();
  });

  it('should preserve parent span as current within runWithSpan', async () => {
    const parent = tracer.startSpan('parent');
    await tracer.runWithSpan(parent, async () => {
      expect(tracer.getCurrentSpan()).toBe(parent);
      const child = tracer.startSpan('child');
      expect(child.context.parentSpanId).toBe(parent.context.spanId);
      // Starting a child does not change the ambient current span
      expect(tracer.getCurrentSpan()).toBe(parent);
      tracer.endSpan(child);
      expect(tracer.getCurrentSpan()).toBe(parent);
    });
    // After runWithSpan completes, no span is ambient
    expect(tracer.getCurrentSpan()).toBeNull();
  });

  it('should not let concurrent async operations overwrite each other context', async () => {
    const results: string[] = [];

    async function work(id: string, spanName: string) {
      const span = tracer.startSpan(spanName);
      await tracer.runWithSpan(span, async () => {
        results.push(`${id}:start:${tracer.getCurrentSpan()!.context.spanId}`);
        await new Promise(resolve => setImmediate(resolve));
        results.push(`${id}:after-await:${tracer.getCurrentSpan()!.context.spanId}`);
      });
      tracer.endSpan(span);
    }

    await Promise.all([work('a', 'span-a'), work('b', 'span-b')]);

    // Each operation's spanId should be consistent before and after await.
    const aResults = results.filter(r => r.startsWith('a:'));
    const bResults = results.filter(r => r.startsWith('b:'));
    expect(aResults[0].split(':')[2]).toBe(aResults[1].split(':')[2]);
    expect(bResults[0].split(':')[2]).toBe(bResults[1].split(':')[2]);
    expect(aResults[0].split(':')[2]).not.toBe(bResults[0].split(':')[2]);
  });

  it('should bound span retention and evict oldest spans', () => {
    const bounded = new InMemoryTracer(3);
    for (let i = 0; i < 5; i++) {
      const span = bounded.startSpan(`span-${i}`);
      bounded.endSpan(span);
    }

    const spans = bounded.getSpans();
    expect(spans.length).toBe(3);
    expect(spans.map(s => s.name)).toEqual(['span-2', 'span-3', 'span-4']);
  });

  it('should export all spans', () => {
    const span = tracer.startSpan('export-test');
    tracer.endSpan(span);
    const exported = tracer.export();
    expect(exported.length).toBe(1);
    expect(exported[0].name).toBe('export-test');
  });

  it('should flush without error', async () => {
    await expect(tracer.flush()).resolves.toBeUndefined();
  });

  it('should preserve trace and span IDs through async operations', async () => {
    const root = tracer.startSpan('root');
    const rootTraceId = root.context.traceId;

    await new Promise(resolve => setImmediate(resolve));

    const child = tracer.startSpan('child', { parent: root });
    expect(child.context.traceId).toBe(rootTraceId);
    expect(child.context.parentSpanId).toBe(root.context.spanId);

    tracer.endSpan(child);
    tracer.endSpan(root);
  });

  it('should create sibling spans with different parentSpanId under same parent', () => {
    const parent = tracer.startSpan('parent');
    const child1 = tracer.startSpan('child-1', { parent });
    const child2 = tracer.startSpan('child-2', { parent });

    expect(child1.context.parentSpanId).toBe(parent.context.spanId);
    expect(child2.context.parentSpanId).toBe(parent.context.spanId);
    expect(child1.context.spanId).not.toBe(child2.context.spanId);

    tracer.endSpan(child1);
    tracer.endSpan(child2);
    tracer.endSpan(parent);
  });
});