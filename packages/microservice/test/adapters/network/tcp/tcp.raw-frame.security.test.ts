import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as net from 'net';
import { TcpTransport } from '../../../../src/adapters/network/tcp/index.js';
import { encodeTcpFrame } from '../../../../src/adapters/network/tcp/frame-parser.js';

describe('TcpTransport raw-frame security', () => {
  let transport: TcpTransport;
  const portHolder: { port: number } = { port: 0 };

  beforeAll(async () => {
    const handler = async (input: unknown, context: any) => ({ principal: context.metadata.get('principal')?.serviceId ?? null, input });
    const authz = { evaluate: vi.fn().mockResolvedValue({ allowed: true }) };
    const authenticator = { authenticate: vi.fn().mockResolvedValue({ authenticated: true, identity: { serviceId: 'caller', serviceName: 'caller', instanceId: 'i', credentials: {}, getRegistration: () => ({} as any), sign: async () => new Uint8Array(), verify: async () => true } }) };
    transport = new TcpTransport({ host: '127.0.0.1', port: 0, maxFrameSize: 1024 * 1024 }, { authorization: authz as any, authenticator: authenticator as any });
    transport.registerMethod('svc', 'method', handler as any);
    await transport.start();
    portHolder.port = (transport as any).server.address().port;
  });

  afterAll(async () => {
    await transport.close();
  });

  function readFrame(socket: net.Socket): Promise<any> {
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) return;
        const payload = buf.slice(4, 4 + len);
        socket.removeListener('data', onData);
        try { resolve(JSON.parse(payload.toString('utf8'))); } catch (e) { reject(e); }
      };
      socket.on('data', onData);
      socket.on('error', reject);
    });
  }

  it('valid authenticated and authorized frame reaches handler with principal', async () => {
    const creds = { type: 'api-key', apiKey: 'valid', issuedAt: Date.now(), issuer: 'x' };
    const socket = net.connect(portHolder.port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.on('connect', resolve));
    socket.write(encodeTcpFrame(Buffer.from(JSON.stringify({ id: '1', service: 'svc', method: 'method', input: { x: 1 }, credentials: creds }))));
    const response = await readFrame(socket);
    socket.end();
    expect(response.ok).toBe(true);
    expect(response.result.principal).toBe('caller');
  });

  it('missing credentials rejected and handler not invoked', async () => {
    const unauthorizedHandler = vi.fn().mockResolvedValue('ok');
    const t2 = new TcpTransport({ host: '127.0.0.1', port: 0, maxFrameSize: 1024 * 1024 }, { authorization: { evaluate: vi.fn().mockResolvedValue({ allowed: true }) } as any, authenticator: { authenticate: vi.fn().mockResolvedValue({ authenticated: false, error: 'missing' }) } as any });
    t2.registerMethod('svc', 'method', unauthorizedHandler);
    await t2.start();
    const p = (t2 as any).server.address().port;
    const socket = net.connect(p, '127.0.0.1');
    await new Promise<void>((resolve) => socket.on('connect', resolve));
    socket.write(encodeTcpFrame(Buffer.from(JSON.stringify({ id: '2', service: 'svc', method: 'method', input: { x: 1 } }))));
    const response = await readFrame(socket);
    socket.end();
    await t2.close();
    expect(unauthorizedHandler).not.toHaveBeenCalled();
    expect(response.ok).toBe(false);
  });
});
