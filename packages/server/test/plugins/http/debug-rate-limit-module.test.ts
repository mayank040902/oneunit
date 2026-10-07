import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

describe("Debug Rate Limit Module", () => {
  it("check rate limit module exports", async () => {
    const mod = await import("@fastify/rate-limit");
    console.log("All keys:", Object.keys(mod));
    console.log("default:", typeof mod.default);
    console.log("module.exports:", typeof mod['module.exports']);
    console.log("fastifyRateLimit:", typeof mod.fastifyRateLimit);
    
    // Check if module.exports is a function
    if (mod['module.exports']) {
      console.log("module.exports is function:", typeof mod['module.exports'] === 'function');
    }
    console.log("default is function:", typeof mod.default === 'function');
  });
});