export interface TransportCapabilities {
  requestResponse: boolean;
  streaming: boolean;
  publishSubscribe: boolean;
  durableDelivery: boolean;
  orderedDelivery: boolean;
  bidirectional: boolean;
}

export interface TransportHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checkedAt: number;
  details?: Record<string, unknown>;
}

export interface TransportMetrics {
  messagesSent: number;
  messagesReceived: number;
  bytesSent: number;
  bytesReceived: number;
  errors: number;
  latencyMs: { min: number; max: number; avg: number; p50: number; p95: number; p99: number };
}

export interface Transport {
  readonly name: string;
  readonly capabilities: TransportCapabilities;

  start(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<TransportHealth>;
}

export interface RpcClient {
  call<TInput, TOutput>(service: string, method: string, input: TInput): Promise<TOutput>;
  stream<TInput, TOutput>(service: string, method: string, input: TInput): AsyncIterable<TOutput>;
}

export interface RpcServer {
  registerMethod(service: string, method: string, handler: RpcMethodHandler): void;
  unregisterMethod(service: string, method: string): void;
}

export type RpcMethodHandler = (input: unknown, context: RpcContext) => Promise<unknown>;

export interface RpcContext {
  serviceId: string;
  correlationId: string;
  headers: Record<string, unknown>;
  metadata: Map<string, unknown>;
}

export interface MessagePublisher {
  publish(topic: string, message: unknown, options?: PublishOptions): Promise<void>;
}

export interface MessageSubscriber {
  subscribe(topic: string, handler: MessageHandler, options?: SubscribeOptions): Promise<void>;
  unsubscribe(topic: string): Promise<void>;
}

export type MessageHandler = (message: unknown, context: MessageContext) => Promise<void>;

export interface MessageContext {
  topic: string;
  correlationId?: string;
  traceContext?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface PublishOptions {
  key?: string;
  headers?: Record<string, string>;
  priority?: number;
}

export interface SubscribeOptions {
  groupId?: string;
  fromBeginning?: boolean;
  autoAck?: boolean;
}

export interface StreamTransport {
  openStream(remote: string): Promise<DuplexStream>;
}

export interface DuplexStream {
  write(data: Uint8Array): Promise<void>;
  read(): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

export interface DatagramTransport {
  send(data: Uint8Array, target: string, port: number): Promise<void>;
  onMessage(handler: (data: Uint8Array, source: { address: string; port: number }) => void): void;
}