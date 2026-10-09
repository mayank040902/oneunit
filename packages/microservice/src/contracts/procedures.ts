import { z } from 'zod';

export interface ProcedureContract<TInput = unknown, TOutput = unknown> {
  service: string;
  method: string;
  inputSchema: z.ZodSchema<TInput>;
  outputSchema: z.ZodSchema<TOutput>;
  description?: string;
  deprecated?: boolean;
  version: number;
}

export interface ProcedureContext {
  serviceId: string;
  instanceId: string;
  correlationId: string;
  traceContext?: Record<string, string>;
  metadata: Map<string, unknown>;
}

export type ProcedureHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context: ProcedureContext
) => Promise<TOutput>;

export function createProcedureContract<TInput, TOutput>(
  service: string,
  method: string,
  inputSchema: z.ZodSchema<TInput>,
  outputSchema: z.ZodSchema<TOutput>,
  options?: {
    description?: string;
    deprecated?: boolean;
    version?: number;
  }
): ProcedureContract<TInput, TOutput> {
  return {
    service,
    method,
    inputSchema,
    outputSchema,
    description: options?.description,
    deprecated: options?.deprecated ?? false,
    version: options?.version ?? 1,
  };
}

export function validateProcedureInput<TInput>(
  contract: ProcedureContract<TInput, unknown>,
  input: unknown
): { success: true; data: TInput } | { success: false; error: z.ZodError } {
  const result = contract.inputSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function validateProcedureOutput<TOutput>(
  contract: ProcedureContract<unknown, TOutput>,
  output: unknown
): { success: true; data: TOutput } | { success: false; error: z.ZodError } {
  const result = contract.outputSchema.safeParse(output);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}