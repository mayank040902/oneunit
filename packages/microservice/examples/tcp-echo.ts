import { TcpTransport } from '@oneunit/microservice';

async function main() {
  const clientTransport = new TcpTransport({ host: '127.0.0.1', port: 0 });
  await clientTransport.start();

  // openStream returns a DuplexStream for request/response over TCP.
  const stream = await clientTransport.openStream('127.0.0.1:9091');

  await stream.write(Buffer.from('hello from service a'));
  const response = await stream.read();
  console.log('response:', new TextDecoder().decode(response));

  await stream.close();
  await clientTransport.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
