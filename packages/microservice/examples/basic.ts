import { createMicroservice } from '@oneunit/microservice';

async function main() {
  // rootKey must be supplied explicitly via config or CRYPTO_ROOT_KEY env var.
  // It is never generated implicitly by the framework.
  const app = await createMicroservice({
    config: {
      service: {
        id: crypto.randomUUID(),
        name: 'basic-example',
      },
      adapters: {
        kafka: { enabled: false },
        nats: { enabled: false },
      },
      registry: {
        backend: 'memory',
      },
      crypto: {
        rootKey: process.env.CRYPTO_ROOT_KEY,
      },
    },
  });

  await app.start();
  console.log('microservice started');
  await app.stop();
  console.log('microservice stopped');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
