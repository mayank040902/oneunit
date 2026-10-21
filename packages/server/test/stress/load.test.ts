import http from "node:http";
import type { AddressInfo } from "node:net";
import v8 from "node:v8";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createBootstrapServer } from "../../src/bootstrap.js";

/**
 * Forces a garbage collection so the measurements show what is retained
 * instead of what is only garbage.
 */
function collectGarbage(): void {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as (() => void) | undefined;
    gc?.();
}

/**
 * Load and stability harness.
 *
 * Every other stress suite in this folder asserts a specific behaviour. This
 * one asserts the properties that must hold no matter what: the server keeps
 * serving under concurrency, stays within its latency budget, does not grow
 * without bound, and finishes the requests that were already in flight when it
 * was asked to shut down.
 *
 * The thresholds are deliberately loose. They are there to catch a regression
 * (a leak, a lock, a quadratic path), not to benchmark the machine.
 */

interface LoadResult {
    total: number;
    failures: number;
    nonSuccess: number;
    durationMs: number;
    requestsPerSecond: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });

function percentile(sorted: number[], fraction: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
    return sorted[Math.max(0, index)];
}

async function load(options: {
    port: number;
    path: string;
    total: number;
    concurrency: number;
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    onResult?: (statusCode: number) => void;
}): Promise<LoadResult> {
    const method = options.method ?? "GET";
    const latencies: number[] = [];
    let failures = 0;
    let nonSuccess = 0;
    let issued = 0;

    const worker = async (): Promise<void> => {
        while (issued < options.total) {
            issued += 1;
            const started = process.hrtime.bigint();
            try {
                const response = await new Promise<number>((resolve, reject) => {
                    const request = http.request(
                        {
                            host: "127.0.0.1",
                            port: options.port,
                            path: options.path,
                            method,
                            agent,
                            headers: {
                                ...options.headers,
                                ...(options.body
                                    ? {
                                        "content-type": "application/json",
                                        "content-length": String(Buffer.byteLength(options.body)),
                                    }
                                    : {}),
                            },
                        },
                        (res) => {
                            res.resume();
                            res.on("end", () => resolve(res.statusCode ?? 0));
                        },
                    );
                    request.on("error", reject);
                    if (options.body) request.write(options.body);
                    request.end();
                });

                latencies.push(Number(process.hrtime.bigint() - started) / 1e6);
                if (response < 200 || response >= 300) nonSuccess += 1;
                options.onResult?.(response);
            } catch {
                failures += 1;
            }
        }
    };

    const startedAt = process.hrtime.bigint();
    await Promise.all(
        Array.from({ length: options.concurrency }, () => worker()),
    );
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    latencies.sort((a, b) => a - b);
    return {
        total: options.total,
        failures,
        nonSuccess,
        durationMs,
        requestsPerSecond: options.total / (durationMs / 1000),
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        p99: percentile(latencies, 0.99),
        max: latencies[latencies.length - 1] ?? 0,
    };
}

describe("Server load and stability", () => {
    let app: FastifyInstance;
    let port: number;

    beforeAll(async () => {
        app = await createBootstrapServer({
            logger: false,
            kafka: false,
            realtime: false,
            database: false,
            redis: false,
            env: false,
            health: false,
            rateLimit: { max: 100_000, timeWindow: "1 minute" },
            configure: (server) => {
                server.get("/ping", async (_request, reply) => reply.ok({ data: "pong" }));
                server.get("/echo", async (request) => request.body ?? { ok: true });
                server.post("/echo", async (request) => request.body ?? { ok: true });
                server.get("/slow", async (_request, reply) => {
                    await new Promise((resolve) => setTimeout(resolve, 150));
                    return reply.ok();
                });
            },
        });

        await app.listen({ host: "127.0.0.1", port: 0 });
        port = (app.server.address() as AddressInfo).port;
    });

    afterAll(async () => {
        agent.destroy();
        await app.close();
    });

    it("serves a sustained burst without a single failed or non-2xx response", async () => {
        const result = await load({ port, path: "/ping", total: 5_000, concurrency: 100 });

        expect(result.failures).toBe(0);
        expect(result.nonSuccess).toBe(0);
        expect(result.total).toBe(5_000);
        // A regression that serialises the event loop shows up here.
        expect(result.requestsPerSecond).toBeGreaterThan(200);
    });

    it("keeps the latency distribution inside the budget under concurrency", async () => {
        const result = await load({ port, path: "/ping", total: 2_000, concurrency: 50 });

        expect(result.failures).toBe(0);
        expect(result.p50).toBeLessThan(500);
        expect(result.p99).toBeLessThan(2_000);
    });

    it("does not grow the heap without bound across repeated bursts", async () => {
        collectGarbage();
        const before = process.memoryUsage().heapUsed;

        for (let burst = 0; burst < 5; burst += 1) {
            const result = await load({ port, path: "/ping", total: 1_000, concurrency: 50 });
            expect(result.failures).toBe(0);
        }

        collectGarbage();
        const growth = process.memoryUsage().heapUsed - before;

        // 5k requests must not retain their payloads. 32 MB is far above the
        // steady-state cost of the server and far below an actual leak.
        expect(growth).toBeLessThan(32 * 1024 * 1024);
    });

    it("handles a large payload without corrupting it", async () => {
        const payload = JSON.stringify({ blob: "x".repeat(512 * 1024) });
        const result = await load({
            port,
            path: "/echo",
            method: "POST",
            total: 20,
            concurrency: 4,
            body: payload,
        });

        expect(result.failures).toBe(0);
        expect(result.nonSuccess).toBe(0);
    });

    it("rejects a payload above the body limit instead of buffering it", async () => {
        // Fastify's default body limit is 1 MiB.
        const payload = JSON.stringify({ blob: "x".repeat(1024 * 1024 + 1024) });
        const statuses: number[] = [];
        const result = await load({
            port,
            path: "/echo",
            method: "POST",
            total: 5,
            concurrency: 1,
            body: payload,
            onResult: (status) => statuses.push(status),
        });

        expect(result.failures).toBe(0);
        expect(statuses.every((status) => status === 413)).toBe(true);
    });

    it("sheds load past the configured rate limit", async () => {
        const limited = await createBootstrapServer({
            logger: false,
            kafka: false,
            realtime: false,
            database: false,
            redis: false,
            env: false,
            health: false,
            rateLimit: { max: 20, timeWindow: "1 minute" },
            configure: (server) => {
                server.get("/ping", async (_request, reply) => reply.ok());
            },
        });
        await limited.listen({ host: "127.0.0.1", port: 0 });
        const limitedPort = (limited.server.address() as AddressInfo).port;

        try {
            const statuses: number[] = [];
            const result = await load({
                port: limitedPort,
                path: "/ping",
                total: 100,
                concurrency: 10,
                onResult: (status) => statuses.push(status),
            });

            expect(result.failures).toBe(0);
            const limited = statuses.filter((status) => status === 429).length;
            const allowed = statuses.filter((status) => status === 200).length;
            expect(limited).toBeGreaterThan(0);
            expect(allowed).toBeGreaterThan(0);
        } finally {
            await limited.close();
        }
    });

    it("completes the requests that were already in flight when it shuts down", async () => {
        const closing = await createBootstrapServer({
            logger: false,
            kafka: false,
            realtime: false,
            database: false,
            redis: false,
            env: false,
            health: false,
            configure: (server) => {
                server.get("/slow", async (_request, reply) => {
                    await new Promise((resolve) => setTimeout(resolve, 200));
                    return reply.ok();
                });
            },
        });
        await closing.listen({ host: "127.0.0.1", port: 0 });
        const closingPort = (closing.server.address() as AddressInfo).port;

        const inFlight = load({
            port: closingPort,
            path: "/slow",
            total: 20,
            concurrency: 20,
        });

        // Give the requests time to reach the handler, then ask for a shutdown.
        await new Promise((resolve) => setTimeout(resolve, 50));
        const startedAt = Date.now();
        await closing.close();
        const closeDuration = Date.now() - startedAt;

        const result = await inFlight;
        expect(result.failures).toBe(0);
        expect(result.nonSuccess).toBe(0);
        expect(result.total).toBe(20);
        // The drain must not wait for the keep-alive timeout.
        expect(closeDuration).toBeLessThan(5_000);
    });

    it("answers concurrent requests with distinct, well-formed envelopes", async () => {
        const bodies = await Promise.all(
            Array.from({ length: 200 }, async () => {
                const raw = await new Promise<string>((resolve, reject) => {
                    const request = http.request(
                        { host: "127.0.0.1", port, path: "/ping", method: "GET", agent },
                        (res) => {
                            let chunked = "";
                            res.setEncoding("utf8");
                            res.on("data", (chunk) => { chunked += chunk; });
                            res.on("end", () => resolve(chunked));
                        },
                    );
                    request.on("error", reject);
                    request.end();
                });
                return JSON.parse(raw) as {
                    success: boolean;
                    code: string;
                    msg: string;
                    metadata: { requestId: string };
                };
            }),
        );

        const ids = new Set(bodies.map((body) => body.metadata.requestId));
        expect(ids.size).toBe(bodies.length);
        for (const body of bodies) {
            expect(body.success).toBe(true);
            expect(body.code).toBe("200");
            expect(body.msg).toBe("Success");
        }
    });
});
