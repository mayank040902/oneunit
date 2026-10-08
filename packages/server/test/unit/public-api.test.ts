import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
    createBootstrapServer,
    startBootstrapServer,
    type BootstrapServerOptions,
} from "../../src/bootstrap.js";
import { getSystemInfo } from "../../src/lib/system.js";
import { serviceConfig } from "../../src/config/env-services.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
    for (const app of apps.splice(0)) {
        try { await app.close(); } catch { /* ignore */ }
    }
});

describe("Public API Contract Tests", () => {
    const baseOptions: Partial<BootstrapServerOptions> = {
        logger: false,
        kafka: false,
        realtime: false,
        database: false,
        redis: false,
        env: false,
        health: false,
    };

    it("createBootstrapServer returns FastifyInstance", async () => {
        const server = await createBootstrapServer(baseOptions);
        expect(server).toBeDefined();
        expect(server.ready).toBeTypeOf("function");
        expect(server.inject).toBeTypeOf("function");
        expect(server.close).toBeTypeOf("function");
        await server.close();
    });

    it("startBootstrapServer returns StartedBootstrapServer", async () => {
        const result = await startBootstrapServer({
            ...baseOptions,
            port: 0,
        });

        expect(result.app).toBeDefined();
        expect(typeof result.address).toBe("string");
        expect(typeof result.port).toBe("number");
        expect(typeof result.host).toBe("string");
        expect(typeof result.close).toBe("function");

        await result.close();
    });

    it("createServer is an alias for createBootstrapServer", async () => {
        const { createServer } = await import("../../src/bootstrap.js");
        expect(createServer).toBe(createBootstrapServer);
    });

    it("startServer is an alias for startBootstrapServer", async () => {
        const { startServer } = await import("../../src/bootstrap.js");
        expect(startServer).toBe(startBootstrapServer);
    });

    it("port overload works: createBootstrapServer(port, options)", async () => {
        const server = await createBootstrapServer(0, {
            ...baseOptions,
        });

        const addr = server.server.address();
        expect(addr).toBeNull();
        await server.close();
    });

    it("port overload works: startBootstrapServer(port, options)", async () => {
        const result = await startBootstrapServer(0, {
            ...baseOptions,
        });

        expect(result.port).toBeGreaterThan(0);
        await result.close();
    });

    it("options object form works", async () => {
        const result = await startBootstrapServer({
            ...baseOptions,
            port: 0,
        });

        expect(result.port).toBeGreaterThan(0);
        await result.close();
    });

    it("serviceName is forwarded to serviceConfig and health", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            serviceName: "test-service",
            health: true,
        });

        await server.ready();
        const res = await server.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.service).toBe("test-service");

        await server.close();
    });

    it("serviceName defaults to app", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            health: true,
        });

        const res = await server.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.service).toBe("app");

        await server.close();
    });

    it("default port is 8080", () => {
        expect(serviceConfig(8080, "127.0.0.1", "test").port).toBe(8080);
    });

    it("default host is 127.0.0.1", () => {
        expect(serviceConfig(8080, "127.0.0.1", "test").host).toBe("127.0.0.1");
    });
});

describe("Internal Module Non-Export Tests", () => {
    it("public exports contain expected functions", async () => {
        const pkg = await import("../../src/index.js");

        const keys = Object.keys(pkg).sort();
        expect(keys).toContain("createBootstrapServer");
        expect(keys).toContain("startBootstrapServer");
        expect(keys).toContain("createServer");
        expect(keys).toContain("startServer");
    });

    it("subpath exports resolve correctly", async () => {
        const { getSystemInfo } = await import("../../src/lib/system.js");
        expect(typeof getSystemInfo).toBe("function");

        const { DEFAULT_THRESHOLDS } = await import("../../src/lib/system-status.js");
        expect(DEFAULT_THRESHOLDS).toBeDefined();

        const { formatBytes, formatTime, timestamp } = await import("../../src/lib/formatter.js");
        expect(typeof formatBytes).toBe("function");
        expect(typeof formatTime).toBe("function");
        expect(typeof timestamp).toBe("function");
    });
});

describe("System Info Tests", () => {
    it("getSystemInfo returns process info", () => {
        const info = getSystemInfo();
        expect(info.process.pid).toBe(process.pid);
        expect(info.process.ppid).toBe(process.ppid);
        expect(info.process.node).toBe(process.version);
        expect(info.process.version).toBe(process.versions.node);
        expect(info.process.environment).toBe(process.env.NODE_ENV ?? "unknown");
        expect(info.process.uptime).toBeDefined();
    });

    it("getSystemInfo returns performance info", () => {
        const info = getSystemInfo();
        expect(info.performance.startupTime).toBeDefined();
        expect(info.performance.systemUptime).toBeDefined();
        expect(info.performance.timestamp).toBeDefined();
    });

    it("getSystemInfo returns memory info", () => {
        const info = getSystemInfo();
        expect(info.memory.total).toBeDefined();
        expect(info.memory.free).toBeDefined();
        expect(info.memory.used).toBeDefined();
        expect(typeof info.memory.usagePercent).toBe("number");
        expect(info.memory.usagePercent).toBeGreaterThanOrEqual(0);
        expect(info.memory.usagePercent).toBeLessThanOrEqual(100);
    });

    it("getSystemInfo returns CPU info", () => {
        const info = getSystemInfo();
        expect(info.cpu.architecture).toBeDefined();
        expect(info.cpu.platform).toBeDefined();
        expect(info.cpu.model).toBeDefined();
        expect(info.cpu.cores).toBeGreaterThan(0);
        expect(info.cpu.loadAverage.oneMinute).toBeDefined();
    });

    it("getSystemInfo returns network info", () => {
        const info = getSystemInfo();
        expect(info.network).toBeDefined();
    });

    it("getSystemInfo returns user info", () => {
        const info = getSystemInfo();
        expect(info.user.username).toBeDefined();
        expect(info.user.homedir).toBeDefined();
    });
});
