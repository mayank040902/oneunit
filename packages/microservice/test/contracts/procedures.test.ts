import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  ProcedureContract,
  ProcedureContext,
  ProcedureHandler,
  createProcedureContract,
  validateProcedureInput,
  validateProcedureOutput,
} from '../../src/contracts/procedures.js';

describe('ProcedureContract', () => {
  const inputSchema = z.object({ name: z.string(), age: z.number().int().positive() });
  const outputSchema = z.object({ id: z.string().uuid(), created: z.boolean() });

  it('should create a procedure contract with all required fields', () => {
    const contract = createProcedureContract('UserService', 'createUser', inputSchema, outputSchema);

    expect(contract.service).toBe('UserService');
    expect(contract.method).toBe('createUser');
    expect(contract.inputSchema).toBe(inputSchema);
    expect(contract.outputSchema).toBe(outputSchema);
    expect(contract.description).toBeUndefined();
    expect(contract.deprecated).toBe(false);
    expect(contract.version).toBe(1);
  });

  it('should include optional fields when provided', () => {
    const contract = createProcedureContract('UserService', 'createUser', inputSchema, outputSchema, {
      description: 'Creates a new user',
      deprecated: true,
      version: 2,
    });

    expect(contract.description).toBe('Creates a new user');
    expect(contract.deprecated).toBe(true);
    expect(contract.version).toBe(2);
  });

  it('should accept different schema types', () => {
    const stringInput = z.string();
    const numberOutput = z.number();
    const contract = createProcedureContract('TestService', 'echo', stringInput, numberOutput);

    expect(contract.inputSchema).toBe(stringInput);
    expect(contract.outputSchema).toBe(numberOutput);
  });
});

describe('validateProcedureInput', () => {
  const inputSchema = z.object({ name: z.string(), age: z.number().int().positive() });
  const outputSchema = z.object({ id: z.string().uuid() });
  const contract = createProcedureContract('UserService', 'createUser', inputSchema, outputSchema);

  it('should return success with parsed data for valid input', () => {
    const input = { name: 'John', age: 30 };
    const result = validateProcedureInput(contract, input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(input);
    }
  });

  it('should return failure with ZodError for invalid input type', () => {
    const input = { name: 123, age: 30 };
    const result = validateProcedureInput(contract, input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(z.ZodError);
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('should return failure for missing required fields', () => {
    const input = { name: 'John' };
    const result = validateProcedureInput(contract, input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(z.ZodError);
    }
  });

  it('should return failure for extra fields when schema is strict', () => {
    const strictSchema = z.object({ name: z.string() }).strict();
    const strictContract = createProcedureContract('Test', 'method', strictSchema, outputSchema);
    const input = { name: 'John', extra: 'field' };
    const result = validateProcedureInput(strictContract, input);

    expect(result.success).toBe(false);
  });

  it('should return failure for null input', () => {
    const result = validateProcedureInput(contract, null);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(z.ZodError);
    }
  });

  it('should return failure for undefined input', () => {
    const result = validateProcedureInput(contract, undefined);

    expect(result.success).toBe(false);
  });

  it('should return failure for primitive input', () => {
    const result = validateProcedureInput(contract, 'string');

    expect(result.success).toBe(false);
  });
});

describe('validateProcedureOutput', () => {
  const inputSchema = z.object({ name: z.string() });
  const outputSchema = z.object({ id: z.string().uuid(), created: z.boolean() });
  const contract = createProcedureContract('UserService', 'createUser', inputSchema, outputSchema);

  it('should return success with parsed data for valid output', () => {
    const output = { id: '123e4567-e89b-12d3-a456-426614174000', created: true };
    const result = validateProcedureOutput(contract, output);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(output);
    }
  });

  it('should return failure with ZodError for invalid output type', () => {
    const output = { id: 'not-a-uuid', created: true };
    const result = validateProcedureOutput(contract, output);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(z.ZodError);
    }
  });

  it('should return failure for missing required fields', () => {
    const output = { id: '123e4567-e89b-12d3-a456-426614174000' };
    const result = validateProcedureOutput(contract, output);

    expect(result.success).toBe(false);
  });

  it('should return failure for null output', () => {
    const result = validateProcedureOutput(contract, null);

    expect(result.success).toBe(false);
  });

  it('should return failure for undefined output', () => {
    const result = validateProcedureOutput(contract, undefined);

    expect(result.success).toBe(false);
  });
});

describe('ProcedureContext', () => {
  it('should define the correct structure', () => {
    const context: ProcedureContext = {
      serviceId: '123e4567-e89b-12d3-a456-426614174000',
      instanceId: '123e4567-e89b-12d3-a456-426614174001',
      correlationId: 'corr-123',
      traceContext: { 'trace-id': 'trace-123' },
      metadata: new Map([['key', 'value']]),
    };

    expect(context.serviceId).toBeDefined();
    expect(context.instanceId).toBeDefined();
    expect(context.correlationId).toBeDefined();
    expect(context.traceContext).toBeDefined();
    expect(context.metadata).toBeInstanceOf(Map);
  });

  it('should allow optional traceContext', () => {
    const context: ProcedureContext = {
      serviceId: '123e4567-e89b-12d3-a456-426614174000',
      instanceId: '123e4567-e89b-12d3-a456-426614174001',
      correlationId: 'corr-123',
      metadata: new Map(),
    };

    expect(context.traceContext).toBeUndefined();
  });
});

describe('ProcedureHandler', () => {
  it('should accept a handler function with correct signature', async () => {
    const handler: ProcedureHandler<{ name: string }, { id: string }> = async (input, context) => {
      return { id: '123' };
    };

    const context = {
      serviceId: 'svc',
      instanceId: 'inst',
      correlationId: 'corr',
      metadata: new Map(),
    };

    const result = await handler({ name: 'test' }, context);
    expect(result.id).toBe('123');
  });

  it('should support async handlers', async () => {
    let callCount = 0;
    const handler: ProcedureHandler = async () => {
      callCount++;
      await Promise.resolve();
      return { processed: true };
    };

    const context = {
      serviceId: 'svc',
      instanceId: 'inst',
      correlationId: 'corr',
      metadata: new Map(),
    };

    const result = await handler({}, context);
    expect(result.processed).toBe(true);
    expect(callCount).toBe(1);
  });

  it('should propagate errors from handler', async () => {
    const handler: ProcedureHandler = async () => {
      throw new Error('Handler error');
    };

    const context = {
      serviceId: 'svc',
      instanceId: 'inst',
      correlationId: 'corr',
      metadata: new Map(),
    };

    await expect(handler({}, context)).rejects.toThrow('Handler error');
  });
});