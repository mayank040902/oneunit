import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    sequence: {
      hooks: 'list',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
  resolve: {
    alias: {
      '@': resolve(dirname, 'src'),
      '@crypto': resolve(dirname, 'src/crypto'),
      '@transport': resolve(dirname, 'src/transport'),
      '@registry': resolve(dirname, 'src/registry'),
      '@config': resolve(dirname, 'src/config'),
      '@adapters': resolve(dirname, 'src/adapters'),
    },
  },
});