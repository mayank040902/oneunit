import { describe, it, expect, vi } from 'vitest';
import { GrpcTransport, GrpcConfig } from '../../../src/adapters/rpc/grpc/index.js';

function makeConfig(overrides: Partial<GrpcConfig> = {}): GrpcConfig {
  return { endpoint: '127.0.0.1:0', protoPath: '/tmp/test.proto', packageName: 'test', ...overrides };
}

describe('GrpcTransport createGrpcHandler security', () => {
  it('rejects authorization denial through createGrpcHandler', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    const authz = { evaluate: vi.fn().mockResolvedValue({ allowed: false, reason: 'denied' }) };
    const transport = new GrpcTransport(makeConfig(), { authorization: authz as any });
    const grpcHandler = (transport as any).createGrpcHandler(handler, 'svc', 'method');
    const call = { request: { x: 1 }, metadata: { getMap: () => ({}) , get: (_k: string) => undefined } };
    const callback = vi.fn();
    await grpcHandler(call, callback);
    await new Promise((r) => setTimeout(r, 0));
    expect(handler).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalled();
    const err = callback.mock.calls[0][0];
    expect(err).toBeTruthy();
  });

  it('executes through createGrpcHandler when allowed', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    const authz = { evaluate: vi.fn().mockResolvedValue({ allowed: true }) };
    const transport = new GrpcTransport(makeConfig(), { authorization: authz as any });
    const grpcHandler = (transport as any).createGrpcHandler(handler, 'svc', 'method');
    const call = { request: { x: 1 }, metadata: { getMap: () => ({}) , get: (_k: string) => undefined } };
    const callback = vi.fn();
    await grpcHandler(call, callback);
    await new Promise((r) => setTimeout(r, 0));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(null, 'ok');
  });
});
