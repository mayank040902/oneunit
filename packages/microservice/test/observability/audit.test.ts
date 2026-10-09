import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryAuditLogger, createAuditLogger, AuditEventTypes } from '../../src/observability/audit.js';
import { AuditEvent } from '../../src/observability/audit.js';

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    eventId: 'evt-1',
    eventType: 'service.registered',
    timestamp: 1000,
    actor: { serviceId: 'svc-a', instanceId: 'inst-1' },
    action: 'register',
    resource: { type: 'service', id: 'svc-a' },
    outcome: 'success',
    details: { region: 'us' },
    riskLevel: 'low',
    ...overrides,
  };
}

describe('InMemoryAuditLogger', () => {
  let logger: InMemoryAuditLogger;

  beforeEach(() => {
    logger = new InMemoryAuditLogger();
  });

  it('should start with no events', async () => {
    const events = await logger.query({});
    expect(events).toEqual([]);
  });

  it('should log an event and return it on query', async () => {
    const event = makeEvent();
    await logger.log(event);

    const events = await logger.query({});
    expect(events).toEqual([event]);
  });

  it('should cap the event buffer at maxEvents', async () => {
    const bounded = new InMemoryAuditLogger(3);
    for (let i = 0; i < 5; i++) {
      await bounded.log(makeEvent({ eventId: `e${i}`, timestamp: i }));
    }
    const events = await bounded.query({});
    expect(events.length).toBe(3);
    // Oldest entries are shifted out; results are sorted newest-first.
    expect(events.map((e) => e.eventId)).toEqual(['e4', 'e3', 'e2']);
  });

  it('should default maxEvents to 10000', async () => {
    const logger = new InMemoryAuditLogger();
    // Log 10001 events; the oldest should be evicted.
    for (let i = 0; i < 10001; i++) {
      await logger.log(makeEvent({ eventId: `e${i}`, timestamp: i }));
    }
    const events = await logger.query({});
    expect(events.length).toBe(10000);
    expect(events[events.length - 1].eventId).toBe('e1');
    expect(events[0].eventId).toBe('e10000');
  });
});

describe('AuditQuery filtering', () => {
  let logger: InMemoryAuditLogger;

  beforeEach(async () => {
    logger = new InMemoryAuditLogger();
    await logger.log(makeEvent({
      eventId: 'e1',
      eventType: 'service.registered',
      actor: { serviceId: 'svc-a', instanceId: 'i1' },
      resource: { type: 'service', id: 'svc-a' },
      outcome: 'success',
      riskLevel: 'low',
      timestamp: 1000,
    }));
    await logger.log(makeEvent({
      eventId: 'e2',
      eventType: 'authorization.denied',
      actor: { serviceId: 'svc-b', instanceId: 'i2' },
      resource: { type: 'service', id: 'svc-b' },
      outcome: 'failure',
      riskLevel: 'high',
      timestamp: 2000,
    }));
  });

  it('should filter by eventType', async () => {
    const events = await logger.query({ eventType: 'service.registered' });
    expect(events.map((e) => e.eventId)).toEqual(['e1']);
  });

  it('should filter by actorServiceId', async () => {
    const events = await logger.query({ actorServiceId: 'svc-b' });
    expect(events.map((e) => e.eventId)).toEqual(['e2']);
  });

  it('should filter by resourceId', async () => {
    const events = await logger.query({ resourceId: 'svc-b' });
    expect(events.map((e) => e.eventId)).toEqual(['e2']);
  });

  it('should filter by startTime', async () => {
    const events = await logger.query({ startTime: 1500 });
    expect(events.map((e) => e.eventId)).toEqual(['e2']);
  });

  it('should filter by endTime', async () => {
    const events = await logger.query({ endTime: 1500 });
    expect(events.map((e) => e.eventId)).toEqual(['e1']);
  });

  it('should filter by outcome', async () => {
    const events = await logger.query({ outcome: 'failure' });
    expect(events.map((e) => e.eventId)).toEqual(['e2']);
  });

  it('should filter by riskLevel', async () => {
    const events = await logger.query({ riskLevel: 'high' });
    expect(events.map((e) => e.eventId)).toEqual(['e2']);
  });

  it('should apply limit', async () => {
    const events = await logger.query({ limit: 1 });
    expect(events.length).toBe(1);
    expect(events[0].eventId).toBe('e2');
  });

  it('should sort by timestamp descending', async () => {
    const events = await logger.query({});
    expect(events.map((e) => e.eventId)).toEqual(['e2', 'e1']);
  });
});

describe('createAuditLogger', () => {
  it('should create an InMemoryAuditLogger', () => {
    const logger = createAuditLogger('memory');
    expect(logger).toBeInstanceOf(InMemoryAuditLogger);
  });

  it('should respect the maxEvents option', async () => {
    const logger = createAuditLogger('memory', { maxEvents: 2 });
    await logger.log(makeEvent({ eventId: 'e1', timestamp: 1 }));
    await logger.log(makeEvent({ eventId: 'e2', timestamp: 2 }));
    await logger.log(makeEvent({ eventId: 'e3', timestamp: 3 }));
    const events = await logger.query({});
    expect(events.map((e) => e.eventId)).toEqual(['e3', 'e2']);
  });
});

describe('AuditEventTypes', () => {
  it('should define documented event type constants', () => {
    expect(AuditEventTypes.SERVICE_REGISTERED).toBe('service.registered');
    expect(AuditEventTypes.SERVICE_DEREGISTERED).toBe('service.deregistered');
    expect(AuditEventTypes.CREDENTIAL_ROTATED).toBe('credential.rotated');
    expect(AuditEventTypes.AUTHORIZATION_DENIED).toBe('authorization.denied');
    expect(AuditEventTypes.CONFIGURATION_CHANGED).toBe('configuration.changed');
    expect(AuditEventTypes.SECURITY_ALERT).toBe('security.alert');
    expect(AuditEventTypes.DATA_ACCESS).toBe('data.access');
    expect(AuditEventTypes.DATA_MODIFIED).toBe('data.modified');
  });
});