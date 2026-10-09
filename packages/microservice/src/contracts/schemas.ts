import { z } from 'zod';

export const ServiceRegistrationSchema = z.object({
  serviceId: z.string().uuid(),
  serviceName: z.string().min(1),
  instanceId: z.string().uuid(),
  endpoints: z.array(z.object({
    protocol: z.enum(['tcp', 'udp', 'trpc', 'grpc', 'connect', 'kafka', 'nats']),
    host: z.string(),
    port: z.number().int().positive(),
    tls: z.boolean().default(false),
  })),
  capabilities: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
  registeredAt: z.number(),
});

export const ServiceInstanceSchema = z.object({
  serviceId: z.string().uuid(),
  instanceId: z.string().uuid(),
  endpoints: z.array(z.object({
    protocol: z.enum(['tcp', 'udp', 'trpc', 'grpc', 'connect', 'kafka', 'nats']),
    host: z.string(),
    port: z.number().int().positive(),
    tls: z.boolean().default(false),
  })),
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  lastHeartbeat: z.number(),
  leaseExpiresAt: z.number(),
  capabilities: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
});

export const HealthCheckSchema = z.object({
  serviceId: z.string().uuid(),
  instanceId: z.string().uuid(),
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  timestamp: z.number(),
  details: z.record(z.unknown()).optional(),
});

export type ServiceRegistration = z.infer<typeof ServiceRegistrationSchema>;
export type ServiceInstance = z.infer<typeof ServiceInstanceSchema>;
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

export interface ServiceQuery {
  serviceId?: string;
  serviceName?: string;
  status?: ServiceInstance['status'];
  capability?: string;
  limit?: number;
}

export const Schemas = {
  ServiceRegistration: ServiceRegistrationSchema,
  ServiceInstance: ServiceInstanceSchema,
  HealthCheck: HealthCheckSchema,
} as const;