import { describe, expect, it } from "vitest";
import {
    DEFAULT_THRESHOLDS,
    getSystemStatus,
    type SystemMetrics,
    type SystemThresholds,
    type HealthChecks,
} from "../../../src/lib/system-status.js";

describe("SystemStatus", () => {
    describe("DEFAULT_THRESHOLDS", () => {
        it("has memory thresholds", () => {
            expect(DEFAULT_THRESHOLDS.memory).toEqual({
                degraded: 75,
                unhealthy: 90,
            });
        });

        it("has load thresholds", () => {
            expect(DEFAULT_THRESHOLDS.load).toEqual({
                degraded: 0.7,
                unhealthy: 1,
            });
        });
    });

    describe("getSystemStatus", () => {
        const healthyMetrics: SystemMetrics = {
            memory: { usagePercent: 50 },
            cpu: { cores: 4, loadAverage: { oneMinute: 1 } },
        };

        it("returns healthy when all checks pass and resources are low", () => {
            const checks: HealthChecks = { a: { status: true }, b: { status: true } };
            expect(getSystemStatus(healthyMetrics, checks)).toBe("healthy");
        });

        it("returns unhealthy when any check fails", () => {
            const checks: HealthChecks = {
                ok: { status: true },
                fail: { status: false },
            };
            expect(getSystemStatus(healthyMetrics, checks)).toBe("unhealthy");
        });

        it("returns degraded when memory usage is in degraded range", () => {
            const metrics: SystemMetrics = {
                memory: { usagePercent: 80 },
                cpu: { cores: 4, loadAverage: { oneMinute: 0.5 } },
            };
            const checks: HealthChecks = { a: { status: true } };
            expect(getSystemStatus(metrics, checks)).toBe("degraded");
        });

        it("returns degraded when load is in degraded range", () => {
            const metrics: SystemMetrics = {
                memory: { usagePercent: 50 },
                cpu: { cores: 4, loadAverage: { oneMinute: 3 } },
            };
            const checks: HealthChecks = { a: { status: true } };
            expect(getSystemStatus(metrics, checks)).toBe("degraded");
        });

        it("returns unhealthy when memory usage is in unhealthy range", () => {
            const metrics: SystemMetrics = {
                memory: { usagePercent: 95 },
                cpu: { cores: 4, loadAverage: { oneMinute: 0.5 } },
            };
            const checks: HealthChecks = { a: { status: true } };
            expect(getSystemStatus(metrics, checks)).toBe("unhealthy");
        });

        it("returns unhealthy when load is in unhealthy range", () => {
            const metrics: SystemMetrics = {
                memory: { usagePercent: 50 },
                cpu: { cores: 4, loadAverage: { oneMinute: 4.5 } },
            };
            const checks: HealthChecks = { a: { status: true } };
            expect(getSystemStatus(metrics, checks)).toBe("unhealthy");
        });

        it("uses custom thresholds", () => {
            const metrics: SystemMetrics = {
                memory: { usagePercent: 80 },
                cpu: { cores: 4, loadAverage: { oneMinute: 0.5 } },
            };
            const customThresholds: SystemThresholds = {
                memory: { degraded: 90, unhealthy: 95 },
                load: { degraded: 0.9, unhealthy: 1.5 },
            };
            const checks: HealthChecks = { a: { status: true } };
            expect(getSystemStatus(metrics, checks, customThresholds)).toBe("healthy");
        });

        it("handles zero CPU cores safely", () => {
            const metrics: SystemMetrics = {
                memory: { usagePercent: 95 },
                cpu: { cores: 0, loadAverage: { oneMinute: 100 } },
            };
            const checks: HealthChecks = { a: { status: true } };
            expect(getSystemStatus(metrics, checks)).toBe("unhealthy");
        });

        it("failed check takes priority over resource status", () => {
            const metrics: SystemMetrics = {
                memory: { usagePercent: 95 },
                cpu: { cores: 4, loadAverage: { oneMinute: 4.5 } },
            };
            const checks: HealthChecks = { fail: { status: false } };
            expect(getSystemStatus(metrics, checks)).toBe("unhealthy");
        });
    });
});
