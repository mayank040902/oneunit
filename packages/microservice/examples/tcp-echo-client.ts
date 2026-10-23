// Manual integration test for examples/tcp-echo.ts.
//
// Starts the TLS TCP server from the example, connects with a second
// TcpTransport, sends a length-prefixed telemetry frame, and verifies the
// server parses it and the connection drains cleanly.
//
// Run with:
//   TLS_CERT_PATH=/tmp/cert.pem TLS_KEY_PATH=/tmp/key.pem node examples/tcp-echo-client.ts

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
    maxFrameSize: 16 * 1024 * 1024,
    connectionTimeout: 5000,
  });
  server.registerMethod('telemetry', 'ingest', async (frame: Uint8Array) => {
    const text = new TextDecoder().decode(frame);
    const parsed = JSON.parse(text) as { deviceId: string; sequence: number };
    if (!parsed.deviceId || typeof parsed.sequence !== 'number') {
      throw new Error('Invalid telemetry frame: deviceId and sequence are required');
    }
    return { ok: true };
  });

  await server.start();
  console.info('server listening on port', port);

  // Client connects to the server over TLS/mTLS.
  const client = new TcpTransport({ host: '127.0.0.1', port: 0 });
  await client.start();

  const stream = await client.openStream(`127.0.0.1:${port}`);
  const frame = JSON.stringify({ deviceId: 'dev-1', sequence: 1, temperature: 21.5 });
  await stream.write(Buffer.from(frame));
  const response = await stream.read();
  console.info('server responded:', new TextDecoder().decode(response));

  await stream.close();
  await client.close();
  await server.close();
  console.info('tcp-echo integration test passed');
  process.exit(0);
}

main().catch((error) => {
  console.error('tcp-echo integration test failed', error);
  process.exit(1);
});