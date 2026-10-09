import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryTracer, NoopTracer, createTracer, extractTraceContext, injectTraceContext } from '../../src/observability/tracing.js';
import { Span, SpanContext } from '../../src/observability/tracing.js';

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

  it('should set the current span', () => {
    const span = tracer.startSpan('op');
    expect(tracer.getCurrentSpan()).toBe(span);
  });

  it('should clear the current span on end', () => {
    const span = tracer.startSpan('op');
    tracer.endSpan(span);
    expect(tracer.getCurrentSpan()).toBeNull();
  });

  it('should inherit the parent traceId', () => {
    const parent = tracer.startSpan('parent');
    const child = tracer.startSpan('child', { parent });
    expect(child.context.traceId).toBe(parent.context.traceId);
    expect(child.context.parentSpanId).toBe(parent.context.spanId);
  });

  it('should inherit the current span as parent by default', () => {
    const parent = tracer.startSpan('parent');
    const child = tracer.startSpan('child');
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
    expect(context).toEqual({ traceId: 't1', spanId: 's1', parentSpanId: undefined });
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
});