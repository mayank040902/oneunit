export interface AuditEvent {
  eventId: string;
  eventType: string;
  timestamp: number;
  actor: {
    serviceId: string;
    instanceId: string;
    userId?: string;
  };
  action: string;
  resource: {
    type: string;
    id: string;
  };
  outcome: 'success' | 'failure' | 'partial';
  details: Record<string, unknown>;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

export interface AuditLogger {
  log(event: AuditEvent): Promise<void>;
  query(filter: AuditQuery): Promise<AuditEvent[]>;
}

export interface AuditQuery {
  eventType?: string;
  actorServiceId?: string;
  resourceId?: string;
  startTime?: number;
  endTime?: number;
  outcome?: AuditEvent['outcome'];
  riskLevel?: AuditEvent['riskLevel'];
  limit?: number;
}

export class InMemoryAuditLogger implements AuditLogger {
  private events: AuditEvent[] = [];
  private maxEvents: number;

  constructor(maxEvents = 10000) {
    this.maxEvents = maxEvents;
  }

  async log(event: AuditEvent): Promise<void> {
    this.events.push(event);
    
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }

  async query(filter: AuditQuery): Promise<AuditEvent[]> {
    let results = [...this.events];
    
    if (filter.eventType) {
      results = results.filter(e => e.eventType === filter.eventType);
    }
    
    if (filter.actorServiceId) {
      results = results.filter(e => e.actor.serviceId === filter.actorServiceId);
    }
    
    if (filter.resourceId) {
      results = results.filter(e => e.resource.id === filter.resourceId);
    }
    
    if (filter.startTime) {
      results = results.filter(e => e.timestamp >= filter.startTime!);
    }
    
    if (filter.endTime) {
      results = results.filter(e => e.timestamp <= filter.endTime!);
    }
    
    if (filter.outcome) {
      results = results.filter(e => e.outcome === filter.outcome);
    }
    
    if (filter.riskLevel) {
      results = results.filter(e => e.riskLevel === filter.riskLevel);
    }
    
    results.sort((a, b) => b.timestamp - a.timestamp);
    
    if (filter.limit) {
      results = results.slice(0, filter.limit);
    }
    
    return results;
  }
}

export function createAuditLogger(type: 'memory' = 'memory', options?: { maxEvents?: number }): AuditLogger {
  return new InMemoryAuditLogger(options?.maxEvents);
}

export const AuditEventTypes = {
  SERVICE_REGISTERED: 'service.registered',
  SERVICE_DEREGISTERED: 'service.deregistered',
  CREDENTIAL_ROTATED: 'credential.rotated',
  AUTHORIZATION_DENIED: 'authorization.denied',
  CONFIGURATION_CHANGED: 'configuration.changed',
  SECURITY_ALERT: 'security.alert',
  DATA_ACCESS: 'data.access',
  DATA_MODIFIED: 'data.modified',
} as const;