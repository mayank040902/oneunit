export interface Event<TPayload = unknown> {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  source: {
    serviceId: string;
    instanceId: string;
  };
  timestamp: number;
  correlationId?: string;
  traceContext?: Record<string, string>;
  payload: TPayload;
}

export interface EventSubscription {
  eventType: string;
  handler: (event: Event) => Promise<void>;
  filter?: (event: Event) => boolean;
}

export const SystemEvents = {
  SERVICE_REGISTERED: 'system.service.registered',
  SERVICE_DEREGISTERED: 'system.service.deregistered',
  SERVICE_HEALTH_CHANGED: 'system.service.health_changed',
  CONFIGURATION_CHANGED: 'system.configuration.changed',
  SECURITY_ALERT: 'system.security.alert',
} as const;

export type SystemEventType = typeof SystemEvents[keyof typeof SystemEvents];

export function createEvent<TPayload>(
  eventType: string,
  payload: TPayload,
  source: { serviceId: string; instanceId: string },
  options?: {
    correlationId?: string;
    traceContext?: Record<string, string>;
    schemaVersion?: number;
  }
): Event<TPayload> {
  return {
    eventId: crypto.randomUUID(),
    eventType,
    schemaVersion: options?.schemaVersion ?? 1,
    source,
    timestamp: Date.now(),
    correlationId: options?.correlationId,
    traceContext: options?.traceContext,
    payload,
  };
}