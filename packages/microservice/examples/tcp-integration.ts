// Combined in-process integration test for the TCP adapter.
// Starts a TLS TcpTransport server, connects a second TcpTransport client,
// sends a JSON request envelope, and verifies the server handles it and
// returns a framed response.
//
// Run with:
//   TLS_CERT_PATH=/tmp/cert.pem TLS_KEY_PATH=/tmp/key.pem node examples/tcp-integration.ts

import { TcpTransport } from '@oneunit/microservice';

async function main(): Promise<void> {
  const cert = process.env['TLS_CERT_PATH'];
  const key = process.env['TLS_KEY_PATH'];
  const port = Number(process.env['PORT'] ?? '9091');
  if (!cert || !key) {
    throw new Error('TLS_CERT_PATH and TLS_KEY_PATH must be set');
  }

  const server = new TcpTransport({
    host: '0.0.0.0',
    port,
    tls: true,
    cert,
    key,
    ca: cert,
    rejectUnauthorized: false,
    maxFrameSize: 16 * 1024 * 1024,
    connectionTimeout: 5000,
  });
  server.registerMethod('telemetry', 'ingest', async (frame: { deviceId: string; sequence: number }) => {
    if (!frame?.deviceId || typeof frame.sequence !== 'number') {
      throw new Error('Invalid telemetry frame: deviceId and sequence are required');
    }
    return { ok: true };
  });

  await server.start();
  console.info('server listening on port', port);

  const client = new TcpTransport({
    host: '127.0.0.1',
    port: 0,
    tls: true,
    cert,
    key,
    rejectUnauthorized: false,
  });
  await client.start();

  const stream = await client.openStream(`127.0.0.1:${port}`);
  const request = JSON.stringify({
    id: crypto.randomUUID(),
    service: 'telemetry',
    method: 'ingest',
    input: { deviceId: 'dev-1', sequence: 1, temperature: 21.5 },
  });
  await stream.write(Buffer.from(request));

  // The server responds with a length-prefixed frame. Read with a short
  // retry loop so a slow dispatch does not surface as a null read.
  let response: Uint8Array | null = null;
  for (let i = 0; i < 50 && response === null; i++) {
    response = await stream.read();
    if (response === null) {
      await new Promise<void>((r) => setTimeout(r, 20));
    }
  }
  if (!response) {
    throw new Error('server returned no response');
  }
  const parsed = JSON.parse(Buffer.from(response).toString('utf8'));
  console.info('server responded:', parsed);
  if (!parsed.ok || parsed.result?.ok !== true) {
    throw new Error('unexpected server response');
  }

  await stream.close();
  await client.close();
  await server.close();
  console.info('tcp integration test passed');
  process.exit(0);
}

main().catch((error) => {
  console.error('tcp integration test failed', error);
  process.exit(1);
});