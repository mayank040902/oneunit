import { z } from 'zod';

export const RabbitMQAdapterConfigSchema = z.object({
  url: z.string().default('amqp://localhost:5672'),
  exchangeName: z.string().default('microservice.exchange'),
  defaultQueue: z.string().default('microservice.default'),
  prefetch: z.number().default(1),
  reconnectDelay: z.number().default(5000),
  maxRetries: z.number().default(10),
  maxAttempts: z.number().default(3),
  deadLetterExchange: z.string().optional(),
  durable: z.boolean().default(true),
  autoDelete: z.boolean().default(false),
  exclusive: z.boolean().default(false),
  noAck: z.boolean().default(false),
});

export type RabbitMQAdapterConfig = z.infer<typeof RabbitMQAdapterConfigSchema>;
