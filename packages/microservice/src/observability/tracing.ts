import { AsyncLocalStorage } from 'node:async_hooks';

export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags?: number;
  traceState?: string;
}

export interface Span {
  context: SpanContext;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
  status: SpanStatus;
}

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, unknown>;
}

export interface SpanStatus {
  code: 'ok' | 'error' | 'unset';
  message?: string;
}

export interface Tracer {
  startSpan(name: string, options?: { parent?: Span; attributes?: Record<string, unknown> }): Span;
  endSpan(span: Span): void;
  getCurrentSpan(): Span | null;
}

const DEFAULT_MAX_SPANS = 10000;

function generateId(): string {
  return crypto.randomUUID();
}

export class NoopTracer implements Tracer {
  startSpan(name: string, options?: { parent?: Span; attributes?: Record<string, unknown> }): Span {
    return {
      context: { traceId: '', spanId: '', traceFlags: 0 },
      name,
      startTime: Date.now(),
      attributes: options?.attributes ?? {},
      events: [],
      status: { code: 'unset' },
    };
  }

  endSpan(_span: Span): void {}

  getCurrentSpan(): Span | null {
    return null;
  }
}

export class InMemoryTracer implements Tracer {
  private spans: Span[] = [];
  private maxSpans: number;

  // AsyncLocalStorage provides concurrency-safe ambient tracing context so
  // independent concurrent requests cannot overwrite each other's spans.
  private readonly ambient: AsyncLocalStorage<Span | null> = new AsyncLocalStorage();

  constructor(maxSpans = DEFAULT_MAX_SPANS) {
    this.maxSpans = maxSpans;
  }

  startSpan(name: string, options?: { parent?: Span; attributes?: Record<string, unknown> }): Span {
    const parent = options?.parent ?? this.getCurrentSpan();
    const traceId = parent?.context.traceId ?? generateId();
    const spanId = generateId();

    const span: Span = {
      context: {
        traceId,
        spanId,
        parentSpanId: parent?.context.spanId,
        traceFlags: parent?.context.traceFlags ?? 1,
      },
      name,
      startTime: Date.now(),
      attributes: options?.attributes ?? {},
      events: [],
      status: { code: 'unset' },
    };

    // Bound span retention by evicting the oldest span when at capacity.
    if (this.spans.length >= this.maxSpans) {
      this.spans.shift();
    }

    this.spans.push(span);
    return span;
  }

  endSpan(span: Span): void {
    span.endTime = Date.now();
  }

  /**
   * Runs `fn` within the async context of `span`, so that `getCurrentSpan()`
   * returns `span` (and any spans started inside `fn` inherit from it) for the
   * duration of `fn`, including across await points. Use this to isolate
   * concurrent operations from each other on a shared tracer.
   */
  async runWithSpan<T>(span: Span, fn: () => T | Promise<T>): Promise<T> {
    return this.ambient.run(span, fn);
  }

  getCurrentSpan(): Span | null {
    return this.ambient.getStore() ?? null;
  }

  getSpans(): Span[] {
    return [...this.spans];
  }

  getSpansByTraceId(traceId: string): Span[] {
    return this.spans.filter(s => s.context.traceId === traceId);
  }

  clear(): void {
    this.spans = [];
  }

  export(): Span[] {
    return [...this.spans];
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }
}

export function createTracer(type: 'noop' | 'memory' = 'noop', maxSpans?: number): Tracer {
  switch (type) {
    case 'memory':
      return new InMemoryTracer(maxSpans);
    default:
      return new NoopTracer();
  }
}

export function createAsyncContextTracer(maxSpans?: number): Tracer {
  return new InMemoryTracer(maxSpans);
}

export function extractTraceContext(headers: Record<string, string>): SpanContext | null {
  const traceparent = headers['traceparent'];
  const parts = traceparent ? traceparent.split('-') : [];
  const traceId = parts[1] ?? headers['x-trace-id'];
  const spanId = parts[2] ?? headers['x-span-id'];

  if (!traceId || !spanId) return null;

  return {
    traceId,
    spanId,
    parentSpanId: headers['x-parent-span-id'],
    traceFlags: parts[3] ? parseInt(parts[3], 16) : 1,
  };
}

export function injectTraceContext(context: SpanContext, headers: Record<string, string>): void {
  // Default to sampled (1) when traceFlags is not set, preserving backward
  // compatibility. Honor the actual traceFlags value otherwise.
  const traceFlags = context.traceFlags ?? 1;
  const sampled = (traceFlags & 1) === 1 ? '01' : '00';
  headers['traceparent'] = `00-${context.traceId}-${context.spanId}-${sampled}`;
  headers['x-trace-id'] = context.traceId;
  headers['x-span-id'] = context.spanId;
  if (context.parentSpanId) {
    headers['x-parent-span-id'] = context.parentSpanId;
  }
}
