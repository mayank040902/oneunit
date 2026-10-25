import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
    sequence: { concurrent: false },
    pool: "forks",
    dangerouslyIgnoreUnhandledErrors: true,
    poolOptions: { forks: { rpcTimeout: 120000 } },
  },
});