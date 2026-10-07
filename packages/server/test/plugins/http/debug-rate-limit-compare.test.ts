import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import fastify from "fastify";

describe("Debug Rate Limit Module Comparison", () => {
  it("compare module.exports vs default", async () => {
    const mod = await import("@fastify/rate-limit");
    
    console.log("module.exports === default:", mod['module.exports'] === mod.default);
    console.log("module.exports === fastifyRateLimit:", mod['module.exports'] === mod.fastifyRateLimit);
    console.log("default === fastifyRateLimit:", mod.default === mod.fastifyRateLimit);
    
    // Test both
    const server1 = fastify({ logger: false });
    await server1.register(mod['module.exports'], { max: 2, timeWindow: "1 minute" });
    server1.get("/test1", async () => ({ ok: true }));
    await server1.ready();
    
    const response1 = await server1.inject({ method: "GET", url: "/test1" });
    console.log("module.exports - Request 1:", response1.statusCode);
    const response2 = await server1.inject({ method: "GET", url: "/test1" });
    console.log("module.exports - Request 2:", response2.statusCode);
    const response3 = await server1.inject({ method: "GET", url: "/test1" });
    console.log("module.exports - Request 3:", response3.statusCode);
    await server1.close();
    
    const server2 = fastify({ logger: false });
    await server2.register(mod.default, { max: 2, timeWindow: "1 minute" });
    server2.get("/test2", async () => ({ ok: true }));
    await server2.ready();
    
    const response4 = await server2.inject({ method: "GET", url: "/test2" });
    console.log("default - Request 1:", response4.statusCode);
    const response5 = await server2.inject({ method: "GET", url: "/test2" });
    console.log("default - Request 2:", response5.statusCode);
    const response6 = await server2.inject({ method: "GET", url: "/test2" });
    console.log("default - Request 3:", response6.statusCode);
    await server2.close();
  });
});