import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

describe("Debug @oneunit/errors/fastify import", () => {
  it("check module exports", async () => {
    const mod = await import("@oneunit/errors/fastify");
    console.log("Module keys:", Object.keys(mod));
    console.log("default:", typeof mod.default);
    console.log("errorHandlerPlugin:", typeof mod.errorHandlerPlugin);
    console.log("module.exports:", typeof mod['module.exports']);
  });
});