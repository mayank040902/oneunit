import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["test/**/*.test.js", "test/**/*.test.ts", "test/**/*.test.mjs"],
    },
    esbuild: {
        target: "node20",
    },
    plugins: [],
});
