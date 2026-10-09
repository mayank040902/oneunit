import { describe, it, expect } from 'vitest';
import {
  ServiceRegistrationSchema,
  ServiceInstanceSchema,
  HealthCheckSchema,
  type ServiceRegistration,
  type ServiceInstance,
  type HealthCheck,
  ServiceQuery,
  Schemas,
} from '../../src/contracts/schemas.js';

describe('ServiceRegistrationSchema', () => {
  const validRegistration = {
    serviceId: '123e4567-e89b-12d3-a456-426614174000',
    serviceName: 'test-service',
    instanceId: '123e4567-e89b-12d3-a456-426614174001',
    endpoints: [
      { protocol: 'tcp' as const, host: 'localhost', port: 8080, tls: false },
      { protocol: 'grpc' as const, host: 'localhost', port: 9090, tls: true },
    ],
    capabilities: ['rpc', 'messaging'],
    metadata: { version: '1.0.0' },
    registeredAt: Date.now(),
  };

  it('should accept valid service registration', () => {
    const result = ServiceRegistrationSchema.safeParse(validRegistration);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.serviceId).toBe(validRegistration.serviceId);
      expect(result.data.serviceName).toBe(validRegistration.serviceName);
      expect(result.data.instanceId).toBe(validRegistration.instanceId);
      expect(result.data.endpoints).toHaveLength(2);
      expect(result.data.capabilities).toEqual(['rpc', 'messaging']);
      expect(result.data.metadata).toEqual({ version: '1.0.0' });
    }
  });

  it('should require serviceId as UUID', () => {
    const invalid = { ...validRegistration, serviceId: 'not-a-uuid' };
    const result = ServiceRegistrationSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should require serviceName to be non-empty string', () => {
    const invalid = { ...validRegistration, serviceName: '' };
    const result = ServiceRegistrationSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should require instanceId as UUID', () => {
    const invalid = { ...validRegistration, instanceId: 'not-a-uuid' };
    const result = ServiceRegistrationSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should accept valid endpoint protocols', () => {
    const protocols = ['tcp', 'udp', 'trpc', 'grpc', 'connect', 'kafka', 'nats'] as const;
    
    for (const protocol of protocols) {
      const registration = {
        ...validRegistration,
        endpoints: [{ protocol, host: 'localhost', port: 8080 }],
      };
      const result = ServiceRegistrationSchema.safeParse(registration);
      expect(result.success).toBe(true);
    }
  });

  it('should reject invalid endpoint protocol', () => {
    const invalid = { ...validRegistration, endpoints: [{ protocol: 'http' as any, host: 'localhost', port: 8080 }] };
    const result = ServiceRegistrationSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should require host as string', () => {
    const invalid = { ...validRegistration, endpoints: [{ protocol: 'tcp' as const, host: 123, port: 8080 }] };
    const result = ServiceRegistrationSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should require port as positive integer', () => {
    const invalid = { ...validRegistration, endpoints: [{ protocol: 'tcp' as const, host: 'localhost', port: -1 }] };
    const result = ServiceRegistrationSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should reject port 0', () => {
    const invalid = { ...validRegistration, endpoints: [{ protocol: 'tcp' as const, host: 'localhost', port: 0 }] };
    const result = ServiceRegistrationSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should default tls to false', () => {
    const registration = { ...validRegistration, endpoints: [{ protocol: 'tcp' as const, host: 'localhost', port: 8080 }] };
    const result = ServiceRegistrationSchema.safeParse(registration);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.endpoints[0].tls).toBe(false);
    }
  });

  it('should default capabilities to empty array', () => {
    const { capabilities, ...registration } = validRegistration;
    const result = ServiceRegistrationSchema.safeParse(registration);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual([]);
    }
  });

  it('should default metadata to empty object', () => {
    const { metadata, ...registration } = validRegistration;
    const result = ServiceRegistrationSchema.safeParse(registration);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata).toEqual({});
    }
  });

  it('should require registeredAt as number', () => {
    const invalid = { ...validRegistration, registeredAt: 'now' };
    const result = ServiceRegistrationSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should infer correct TypeScript type', () => {
    const registration: ServiceRegistration = validRegistration;
    expect(registration.serviceId).toBeDefined();
  });
});

describe('ServiceInstanceSchema', () => {
  const validInstance = {
    serviceId: '123e4567-e89b-12d3-a456-426614174000',
    instanceId: '123e4567-e89b-12d3-a456-426614174001',
    endpoints: [
      { protocol: 'tcp' as const, host: 'localhost', port: 8080, tls: false },
    ],
    status: 'healthy' as const,
    lastHeartbeat: Date.now(),
    leaseExpiresAt: Date.now() + 30000,
    capabilities: ['rpc'],
    metadata: { zone: 'us-east-1' },
  };

  it('should accept valid service instance', () => {
    const result = ServiceInstanceSchema.safeParse(validInstance);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('healthy');
      expect(result.data.lastHeartbeat).toBeDefined();
      expect(result.data.leaseExpiresAt).toBeDefined();
    }
  });

  it('should accept all valid status values', () => {
    const statuses = ['healthy', 'degraded', 'unhealthy'] as const;
    
    for (const status of statuses) {
      const instance = { ...validInstance, status };
      const result = ServiceInstanceSchema.safeParse(instance);
      expect(result.success).toBe(true);
    }
  });

  it('should reject invalid status', () => {
    const invalid = { ...validInstance, status: 'unknown' };
    const result = ServiceInstanceSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should require lastHeartbeat as number', () => {
    const invalid = { ...validInstance, lastHeartbeat: 'recent' };
    const result = ServiceInstanceSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should require leaseExpiresAt as number', () => {
    const invalid = { ...validInstance, leaseExpiresAt: 'soon' };
    const result = ServiceInstanceSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should default capabilities to empty array', () => {
    const { capabilities, ...instance } = validInstance;
    const result = ServiceInstanceSchema.safeParse(instance);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual([]);
    }
  });

  it('should default metadata to empty object', () => {
    const { metadata, ...instance } = validInstance;
    const result = ServiceInstanceSchema.safeParse(instance);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata).toEqual({});
    }
  });

  it('should infer correct TypeScript type', () => {
    const instance: ServiceInstance = validInstance;
    expect(instance.status).toBe('healthy');
  });
});

describe('HealthCheckSchema', () => {
  const validHealthCheck = {
    serviceId: '123e4567-e89b-12d3-a456-426614174000',
    instanceId: '123e4567-e89b-12d3-a456-426614174001',
    status: 'healthy' as const,
    timestamp: Date.now(),
    details: { cpu: '50%', memory: '256MB' },
  };

  it('should accept valid health check', () => {
    const result = HealthCheckSchema.safeParse(validHealthCheck);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.details).toEqual({ cpu: '50%', memory: '256MB' });
    }
  });

  it('should accept all valid status values', () => {
    const statuses = ['healthy', 'degraded', 'unhealthy'] as const;
    
    for (const status of statuses) {
      const healthCheck = { ...validHealthCheck, status };
      const result = HealthCheckSchema.safeParse(healthCheck);
      expect(result.success).toBe(true);
    }
  });

  it('should reject invalid status', () => {
    const invalid = { ...validHealthCheck, status: 'unknown' };
    const result = HealthCheckSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should make details optional', () => {
    const { details, ...healthCheck } = validHealthCheck;
    const result = HealthCheckSchema.safeParse(healthCheck);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.details).toBeUndefined();
    }
  });

  it('should require timestamp as number', () => {
    const invalid = { ...validHealthCheck, timestamp: 'now' };
    const result = HealthCheckSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should infer correct TypeScript type', () => {
    const healthCheck: HealthCheck = validHealthCheck;
    expect(healthCheck.serviceId).toBeDefined();
  });
});

describe('ServiceQuery', () => {
  it('should define query structure with optional fields', () => {
    const query: ServiceQuery = {
      serviceId: '123e4567-e89b-12d3-a456-426614174000',
      serviceName: 'test-service',
      status: 'healthy',
      capability: 'rpc',
      limit: 10,
    };

    expect(query.serviceId).toBeDefined();
    expect(query.serviceName).toBeDefined();
    expect(query.status).toBe('healthy');
    expect(query.capability).toBe('rpc');
    expect(query.limit).toBe(10);
  });

  it('should allow empty query', () => {
    const query: ServiceQuery = {};
    expect(query.serviceId).toBeUndefined();
    expect(query.limit).toBeUndefined();
  });

  it('should allow partial query', () => {
    const query: ServiceQuery = { serviceName: 'test' };
    expect(query.serviceName).toBe('test');
    expect(query.serviceId).toBeUndefined();
  });
});

describe('Schemas', () => {
  it('should export all schemas', () => {
    expect(Schemas.ServiceRegistration).toBe(ServiceRegistrationSchema);
    expect(Schemas.ServiceInstance).toBe(ServiceInstanceSchema);
    expect(Schemas.HealthCheck).toBe(HealthCheckSchema);
  });

  it('should be declared as const (TypeScript-level readonly)', () => {
    // The object is declared with `as const` which makes it readonly at TypeScript level
    expect(Schemas.ServiceRegistration).toBe(ServiceRegistrationSchema);
    expect(typeof Schemas).toBe('object');
  });
});