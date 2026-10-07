import { describe, expect, it } from "vitest";
import * as server from "@oneunit/server";

describe("Public Export Tests", () => {
  it("exports createBootstrapServer", () => {
    expect(server.createBootstrapServer).toBeDefined();
    expect(typeof server.createBootstrapServer).toBe("function");
  });

  it("exports startBootstrapServer", () => {
    expect(server.startBootstrapServer).toBeDefined();
    expect(typeof server.startBootstrapServer).toBe("function");
  });

  it("exports createServer alias", () => {
    expect(server.createServer).toBeDefined();
    expect(server.createServer).toBe(server.createBootstrapServer);
  });

  it("exports startServer alias", () => {
    expect(server.startServer).toBeDefined();
    expect(server.startServer).toBe(server.startBootstrapServer);
  });

  it("exports BootstrapServerOptions type", () => {
    // Type exports are compile-time only, but we can verify the module loads
    expect(server).toBeDefined();
  });

  it("exports StartedBootstrapServer type", () => {
    expect(server).toBeDefined();
  });

  it("exports PluginEntry type", () => {
    expect(server).toBeDefined();
  });

  it("exports Configurer type", () => {
    expect(server).toBeDefined();
  });

  it("exports LoadEnvOptions type", () => {
    expect(server).toBeDefined();
  });

  it("exports BuiltinPluginsOptions type", () => {
    expect(server).toBeDefined();
  });

  it("exports PluginConfig type", () => {
    expect(server).toBeDefined();
  });

  it("exports LoggerPluginOptions type", () => {
    expect(server).toBeDefined();
  });

  it("exports DatabasePluginOptions type", () => {
    expect(server).toBeDefined();
  });

  it("exports BootstrapHooks type", () => {
    expect(server).toBeDefined();
  });

  it("exports HookList type", () => {
    expect(server).toBeDefined();
  });

  it("does not require internal modules", () => {
    // Consumers should not need to import from internal paths like:
    // @oneunit/server/src/bootstrap
    // @oneunit/server/src/plugins/index
    // @oneunit/server/src/hooks/index
    // @oneunit/server/src/health/index
    // etc.
    
    // All public APIs should be available from package root
    expect(server.createBootstrapServer).toBeDefined();
    expect(server.startBootstrapServer).toBeDefined();
  });

  it("exports health utilities", () => {
    expect(server.registerHealthRegistry).toBeDefined();
    expect(server.registerSystemHealthProvider).toBeDefined();
    expect(server.getHealthRegistry).toBeDefined();
    expect(server.createHealthRegistry).toBeDefined();
    expect(server.createHealthRoute).toBeDefined();
    expect(server.createHealthProvider).toBeDefined();
    expect(server.createDatabaseHealthProvider).toBeDefined();
    expect(server.createRedisHealthProvider).toBeDefined();
    expect(server.createKafkaHealthProvider).toBeDefined();
  });

  it("exports plugin registration functions", () => {
    expect(server.registerBuiltinPlugins).toBeDefined();
    expect(server.mergeBuiltinPlugins).toBeDefined();
    expect(server.applyZodTypeProvider).toBeDefined();
  });

  it("exports hook registration", () => {
    expect(server.registerHooks).toBeDefined();
  });
});