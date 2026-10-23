// Real-world scenario: a low-latency telemetry collector that receives
// length-prefixed TCP frames from edge devices, validates them through the
// secured dispatcher, and streams acknowledgements back over the same
// connection. TLS/mTLS is enabled so only devices presenting a trusted
// certificate can connect.
//
// Run with:
//   node --experimental-vm-modules examples/tcp-echo.ts
//
// This example is illustrative; it requires a TLS certificate and key pair
// to be generated before it can bind.

import { TcpTransport } from '@oneunit/microservice';

interface TelemetryFrame {
  deviceId: string;
  sequence: number;
  temperature: number;
  humidity: number;
  recordedAt: number;
}

function parseTelemetry(raw: Uint8Array): TelemetryFrame {
  const text = new TextDecoder().decode(raw);
  const parsed = JSON.parse(text) as Partial<TelemetryFrame>;
  if (!parsed.deviceId || typeof parsed.sequence !== 'number') {
      throw new Error('Invalid telemetry frame: deviceId and sequence are required');
    }
  return parsed as TelemetryFrame;
}

async function main(): Promise<void> {
  const cert = process.env['TLS_CERT_PATH'];
  const key = process.env['TLS_KEY_PATH'];
  const ca = process.env['TLS_CA_PATH'];
  if (!cert || !key) {
    throw new Error('TLS_CERT_PATH and TLS_KEY_PATH must be set');
  }

  // Server-side transport: listens for inbound length-prefixed frames and
  // enforces the maximum frame size before buffering. TLS/mTLS is enabled
  // so only devices presenting a trusted certificate can connect.
  // `cert`/`key`/`ca` are filesystem paths; the adapter reads the PEM
  // material itself.
  const serverTransport = new TcpTransport({
    host: '0.0.0.0',
    port: Number(process.env['PORT'] ?? '9091'),
    tls: true,
    cert: cert,
    key: key,
    ca: ca,
    maxFrameSize: 16 * 1024 * 1024,
    connectionTimeout: 5000,
  });

  serverTransport.registerMethod('telemetry', 'ingest', async (frame: Uint8Array) => {
    const telemetry = parseTelemetry(frame);
    // In a real deployment this would be written to a time-series store.
    console.info('received telemetry', telemetry);
    return { ok: true };
  });

  await serverTransport.start();
  console.info('telemetry collector listening on 0.0.0.0:9091 (TLS/mTLS)');

  // Client-side transport: used by the collector to dial back out to the
  // configuration service for periodic device allow-list updates.
  const clientTransport = new TcpTransport({ host: '127.0.0.1', port: 0 });
  await clientTransport.start();

  const stream = await clientTransport.openStream('config-service.internal:9092');
  await stream.write(Buffer.from(JSON.stringify({ action: 'fetchAllowList' })));
  const response = await stream.read();
  console.info('config-service response:', new TextDecoder().decode(response));
  await stream.close();

  // Graceful shutdown: reverse order so the client connection is closed
  // before the listener stops accepting new frames.
  const shutdown = async (): Promise<void> => {
    await clientTransport.close();
    await serverTransport.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Block until a signal triggers shutdown.
  await new Promise<void>(() => {
    /* never resolves */
  });
}

main().catch((error) => {
  console.error('tcp-echo example failed', error);
  process.exit(1);
});