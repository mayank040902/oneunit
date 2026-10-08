import { beforeEach, describe, expect, it } from "vitest";
import { createHealthProvider } from "../../src/health/index.js";
import { createHealthRegistry } from "../../src/health/registry.js";
import { getSystemStatus, DEFAULT_THRESHOLDS } from "../../src/lib/system-status.js";
import type { HealthProvider, HealthCheckResult } from "../../src/health/types.js";

describe("createHealthProvider", () => {
    it("creates a provider with name, check, and critical flag", () => {
        const check = async (): Promise<HealthCheckResult> => ({ status: "healthy" });
        const provider = createHealthProvider("test", check, true);

        expect(provider.name).toBe("test");
        expect(provider.critical).toBe(true);
        expect(typeof provider.check).toBe("function");
    });

    it("defaults critical to false", () => {
        const provider = createHealthProvider("test", async () => ({ status: "healthy" }));
        expect(provider.critical).toBe(false);
    });

    it("stores the check function", async () => {
        const provider = createHealthProvider("test", async () => ({
            status: "healthy",
            message: "ok",
        }));
        const result = await provider.check();
        expect(result.status).toBe("healthy");
        expect(result.message).toBe("ok");
    });
});

describe("createHealthRegistry", () => {
    let registry: ReturnType<typeof createHealthRegistry>;

    beforeEach(() => {
        registry = createHealthRegistry();
    });

    it("starts empty", () => {
        expect(registry.getAll()).toEqual([]);
    });

    it("registers a provider", () => {
        const provider: HealthProvider = {
            name: "db",
            check: async () => ({ status: "healthy" }),
            critical: true,
        };
        registry.register(provider);
        expect(registry.getAll()).toContain(provider);
    });

    it("overwrites duplicate provider by name", () => {
        const provider1: HealthProvider = {
            name: "db",
            check: async () => ({ status: "healthy" }),
        };
        const provider2: HealthProvider = {
            name: "db",
            check: async () => ({ status: "unhealthy" }),
        };
        registry.register(provider1);
        registry.register(provider2);
        expect(registry.getAll()).toEqual([provider2]);
    });

    it("unregisters a provider", () => {
        const provider: HealthProvider = {
            name: "db",
            check: async () => ({ status: "healthy" }),
        };
        registry.register(provider);
        registry.unregister("db");
        expect(registry.getAll()).toEqual([]);
    });

    it("unregister on non-existent provider is a no-op", () => {
        expect(() => registry.unregister("nonexistent")).not.toThrow();
    });

    describe("checkAll", () => {
        it("returns results for all registered providers", async () => {
            registry.register({
                name: "a",
                check: async () => ({ status: "healthy" }),
            });
            registry.register({
                name: "b",
                check: async () => ({ status: "degraded" }),
            });

            const results = await registry.checkAll();
            expect(results["a"].status).toBe("healthy");
            expect(results["b"].status).toBe("degraded");
        });

        it("includes latency in results", async () => {
            registry.register({
                name: "slow",
                check: async () => {
                    await new Promise((r) => setTimeout(r, 10));
                    return { status: "healthy" };
                },
            });

            const results = await registry.checkAll();
            expect(results["slow"].latency).toBeGreaterThan(0);
        });

        it("converts thrown errors to unhealthy", async () => {
            registry.register({
                name: "broken",
                check: async () => {
                    throw new Error("Connection refused");
                },
            });

            const results = await registry.checkAll();
            expect(results["broken"].status).toBe("unhealthy");
            expect(results["broken"].message).toBe("Connection refused");
        });

        it("converts non-Error throws to unhealthy with generic message", async () => {
            registry.register({
                name: "weird",
                check: async () => {
                    throw "string error";
                },
            });

            const results = await registry.checkAll();
            expect(results["weird"].status).toBe("unhealthy");
            expect(results["weird"].message).toBe("Health check failed");
        });

        it("preserves details from check result", async () => {
            registry.register({
                name: "detailed",
                check: async () => ({
                    status: "healthy",
                    details: { connections: 5 },
                }),
            });

            const results = await registry.checkAll();
            expect(results["detailed"].details).toEqual({ connections: 5 });
        });

        it("returns empty object when no providers registered", async () => {
            const results = await registry.checkAll();
            expect(results).toEqual({});
        });

        it("handles synchronous check functions", async () => {
            registry.register({
                name: "sync",
                check: () => ({ status: "healthy" }),
            });

            const results = await registry.checkAll();
            expect(results["sync"].status).toBe("healthy");
        });
    });
});

describe("Health Status Aggregation Logic", () => {
    it("all healthy → healthy", () => {
        const checks = { a: { status: true }, b: { status: true } };
        const metrics = { memory: { usagePercent: 50 }, cpu: { cores: 4, loadAverage: { oneMinute: 1 } } };
        expect(getSystemStatus(metrics, checks)).toBe("healthy");
    });

    it("any failed check → unhealthy", () => {
        const checks = { ok: { status: true }, fail: { status: false } };
        const metrics = { memory: { usagePercent: 50 }, cpu: { cores: 4, loadAverage: { oneMinute: 1 } } };
        expect(getSystemStatus(metrics, checks)).toBe("unhealthy");
    });

    it("degraded resources → degraded", () => {
        const checks = { a: { status: true } };
        const metrics = { memory: { usagePercent: 80 }, cpu: { cores: 4, loadAverage: { oneMinute: 0.5 } } };
        expect(getSystemStatus(metrics, checks, DEFAULT_THRESHOLDS)).toBe("degraded");
    });
});
