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

export class NoopTracer implements Tracer {
  startSpan(name: string, options?: { parent?: Span; attributes?: Record<string, unknown> }): Span {
    return {
      context: { traceId: '', spanId: '' },
      name,
      startTime: Date.now(),
      attributes: options?.attributes ?? {},
      events: [],
      status: { code: 'unset' },
    };
  }
  
  endSpan(span: Span): void {}
  
  getCurrentSpan(): Span | null {
    return null;
  }
}

export class InMemoryTracer implements Tracer {
  private spans: Span[] = [];
  private currentSpan: Span | null = null;

  startSpan(name: string, options?: { parent?: Span; attributes?: Record<string, unknown> }): Span {
    const parent = options?.parent ?? this.currentSpan;
    const traceId = parent?.context.traceId ?? crypto.randomUUID();
    const spanId = crypto.randomUUID();
    
    const span: Span = {
      context: {
        traceId,
        spanId,
        parentSpanId: parent?.context.spanId,
        traceFlags: 1,
      },
      name,
      startTime: Date.now(),
      attributes: options?.attributes ?? {},
      events: [],
      status: { code: 'unset' },
    };
    
    this.currentSpan = span;
    return span;
  }

  endSpan(span: Span): void {
    span.endTime = Date.now();
    this.spans.push(span);
    
    if (this.currentSpan === span) {
      this.currentSpan = null;
    }
  }

  getCurrentSpan(): Span | null {
    return this.currentSpan;
  }

  getSpans(): Span[] {
    return [...this.spans];
  }

  getSpansByTraceId(traceId: string): Span[] {
    return this.spans.filter(s => s.context.traceId === traceId);
  }

  clear(): void {
    this.spans = [];
    this.currentSpan = null;
  }
}

export function createTracer(type: 'noop' | 'memory' = 'noop'): Tracer {
  switch (type) {
    case 'memory':
      return new InMemoryTracer();
    default:
      return new NoopTracer();
  }
}

export function extractTraceContext(headers: Record<string, string>): SpanContext | null {
  const traceId = headers['traceparent']?.split('-')[1] ?? headers['x-trace-id'];
  const spanId = headers['traceparent']?.split('-')[2] ?? headers['x-span-id'];
  
  if (!traceId || !spanId) return null;
  
  return {
    traceId,
    spanId,
    parentSpanId: headers['x-parent-span-id'],
  };
}

export function injectTraceContext(context: SpanContext, headers: Record<string, string>): void {
  headers['traceparent'] = `00-${context.traceId}-${context.spanId}-01`;
  headers['x-trace-id'] = context.traceId;
  headers['x-span-id'] = context.spanId;
  if (context.parentSpanId) {
    headers['x-parent-span-id'] = context.parentSpanId;
  }
}