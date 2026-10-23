import { ensureConfigFile } from '@oneunit/microservice';

// CRYPTO_ROOT_KEY must be set explicitly (≥ 32 chars). It is never generated
// implicitly by the framework.
if (!process.env.CRYPTO_ROOT_KEY || process.env.CRYPTO_ROOT_KEY.length < 32) {
  throw new Error(
    'CRYPTO_ROOT_KEY must be set (≥ 32 characters) before creating a config file',
  );
}

// Creates ./config.json from validated environment defaults if it does not
// already exist. Never overwrites an existing file.
const path = ensureConfigFile('config.json', {
  service: {
    name: 'basic-example',
  },
  adapters: {
    kafka: { enabled: false },
    nats: { enabled: false },
  },
  registry: {
    backend: 'memory',
  },
});

console.log('Created or reused', path);
