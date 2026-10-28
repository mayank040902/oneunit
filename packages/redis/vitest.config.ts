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
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/index.ts",
        "dist/**",
        "test/**",
        "examples/**",
      ],
      sourceMap: true,
      thresholds: {
        statements: 70,
        branches: 50,
        functions: 60,
        lines: 70,
      },
    },
  },
});