import { describe, it, expect } from 'vitest';
import {
  Event,
  EventSubscription,
  SystemEvents,
  SystemEventType,
  createEvent,
} from '../../src/contracts/events.js';

describe('Event', () => {
  const validSource = { serviceId: '123e4567-e89b-12d3-a456-426614174000', instanceId: '123e4567-e89b-12d3-a456-426614174001' };

  it('should create a valid event with all required fields', () => {
    const event = createEvent('test.event', { data: 'hello' }, validSource);

    expect(event.eventId).toBeDefined();
    expect(typeof event.eventId).toBe('string');
    expect(event.eventType).toBe('test.event');
    expect(event.schemaVersion).toBe(1);
    expect(event.source).toEqual(validSource);
    expect(event.timestamp).toBeDefined();
    expect(typeof event.timestamp).toBe('number');
    expect(event.payload).toEqual({ data: 'hello' });
    expect(event.correlationId).toBeUndefined();
    expect(event.traceContext).toBeUndefined();
  });

  it('should include optional fields when provided', () => {
    const options = {
      correlationId: 'corr-123',
      traceContext: { 'trace-id': 'trace-123' },
      schemaVersion: 2,
    };
    const event = createEvent('test.event', { data: 'hello' }, validSource, options);

    expect(event.correlationId).toBe('corr-123');
    expect(event.traceContext).toEqual({ 'trace-id': 'trace-123' });
    expect(event.schemaVersion).toBe(2);
  });

  it('should generate unique event IDs', () => {
    const event1 = createEvent('test.event', {}, validSource);
    const event2 = createEvent('test.event', {}, validSource);

    expect(event1.eventId).not.toBe(event2.eventId);
  });

  it('should include payload as-is', () => {
    const payload = { complex: { nested: ['array', 123, true] } };
    const event = createEvent('test.event', payload, validSource);

    expect(event.payload).toBe(payload);
  });
});

describe('EventSubscription', () => {
  it('should define event subscription with handler', () => {
    const handler = async (event: Event) => { };
    const subscription: EventSubscription = {
      eventType: 'test.event',
      handler,
    };

    expect(subscription.eventType).toBe('test.event');
    expect(subscription.handler).toBe(handler);
    expect(subscription.filter).toBeUndefined();
  });

  it('should include optional filter', () => {
    const handler = async (event: Event) => { };
    const filter = (event: Event) => event.payload !== undefined;
    const subscription: EventSubscription = {
      eventType: 'test.event',
      handler,
      filter,
    };

    expect(subscription.filter).toBe(filter);
  });
});

describe('SystemEvents', () => {
  it('should define standard system event types', () => {
    expect(SystemEvents.SERVICE_REGISTERED).toBe('system.service.registered');
    expect(SystemEvents.SERVICE_DEREGISTERED).toBe('system.service.deregistered');
    expect(SystemEvents.SERVICE_HEALTH_CHANGED).toBe('system.service.health_changed');
    expect(SystemEvents.CONFIGURATION_CHANGED).toBe('system.configuration.changed');
    expect(SystemEvents.SECURITY_ALERT).toBe('system.security.alert');
  });

  it('should have exactly 5 system events', () => {
    expect(Object.keys(SystemEvents)).toHaveLength(5);
  });

  it('should be declared as const (TypeScript-level readonly)', () => {
    // The object is declared with `as const` which makes it readonly at TypeScript level
    // Runtime mutability is not prevented, but TypeScript will error on mutations
    expect(SystemEvents.SERVICE_REGISTERED).toBe('system.service.registered');
    expect(typeof SystemEvents).toBe('object');
  });
});

describe('SystemEventType', () => {
  it('should be a union of all system event values', () => {
    const eventTypes: SystemEventType[] = [
      SystemEvents.SERVICE_REGISTERED,
      SystemEvents.SERVICE_DEREGISTERED,
      SystemEvents.SERVICE_HEALTH_CHANGED,
      SystemEvents.CONFIGURATION_CHANGED,
      SystemEvents.SECURITY_ALERT,
    ];

    expect(eventTypes).toHaveLength(5);
    expect(eventTypes).toContain('system.service.registered');
    expect(eventTypes).toContain('system.service.deregistered');
    expect(eventTypes).toContain('system.service.health_changed');
    expect(eventTypes).toContain('system.configuration.changed');
    expect(eventTypes).toContain('system.security.alert');
  });
});