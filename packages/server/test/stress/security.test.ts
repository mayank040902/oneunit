import net from "node:net";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBootstrapServer } from "../../src/bootstrap.js";

/**
 * Adversarial suite.
 *
 * Every case here is an input a hostile client can send. The server has to
 * answer with a well-formed response, keep its own state intact, and stay up.
 */

/** Sends a raw request so the parsing rules of Node apply. */
function rawRequest(request: string, port = 0): Promise<string> {
    return new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1", () => {
            socket.write(request);
        });
        let received = "";
        let settled = false;
        const finish = (value: string) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(2_000, () => finish(received));
        socket.on("data", (chunk) => {
            received += chunk.toString("utf8");
            // The status line is enough for the assertions.
            if (received.includes("\r\n")) finish(received);
        });
        socket.on("error", (error) => finish(`socket error: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`));
        socket.on("end", () => finish(received));
        socket.on("close", () => finish(received));
    });
}

describe("Server adversarial behaviour", () => {
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
            configure: (server) => {
                server.post("/echo", async (request) => request.body ?? { ok: true });
                server.get("/header", async (request) => ({
                    value: request.headers["x-echo"] ?? null,
                }));
                server.get("/query", async (request) => ({
                    count: Object.keys(request.query as Record<string, unknown>).length,
                }));
                server.get("/boom/:id", async (request) => {
                    throw new Error(`failure for ${(request.params as { id: string }).id}`);
                });
            },
        });
        await app.ready();
        await app.listen({ host: "127.0.0.1", port: 0 });
        port = (app.server.address() as AddressInfo).port;
    });

    afterAll(async () => {
        await app.close();
    });

    it("does not let a body pollute the prototype", async () => {
        const response = await app.inject({
            method: "POST",
            url: "/echo",
            headers: { "content-type": "application/json" },
            payload: JSON.stringify({ __proto__: { polluted: true }, nested: { __proto__: { polluted: true } } }),
        });

        expect(response.statusCode).toBe(200);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("does not let a query string pollute the prototype", async () => {
        await app.inject({ method: "GET", url: "/query?__proto__[polluted]=true" });

        expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("rejects a request that smuggles a second length", async () => {
        const response = await app.inject({
            method: "POST",
            url: "/echo",
            headers: {
                "content-type": "application/json",
                "content-length": "9",
                "transfer-encoding": "chunked",
            },
            payload: JSON.stringify({ a: 1 }),
        });

        expect([400, 413]).toContain(response.statusCode);
    });

    it("answers a deeply nested body without crashing", async () => {
        let payload: unknown = { value: 1 };
        for (let depth = 0; depth < 200; depth += 1) {
            payload = { nested: payload };
        }

        const response = await app.inject({
            method: "POST",
            url: "/echo",
            headers: { "content-type": "application/json" },
            payload: JSON.stringify(payload),
        });

        expect(response.statusCode).toBe(200);
    });

    it("answers a body that is not JSON without crashing", async () => {
        const response = await app.inject({
            method: "POST",
            url: "/echo",
            headers: { "content-type": "application/json" },
            payload: "not json at all",
        });

        expect([400, 415]).toContain(response.statusCode);
    });

    it("does not reflect a header value into the answer unescaped", async () => {
        const response = await app.inject({
            method: "GET",
            url: "/header",
            headers: { "x-echo": "<script>alert(1)</script>" },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toContain("application/json");
        expect(response.json().value).toBe("<script>alert(1)</script>");
    });

    it("does not let a header value inject a response header", async () => {
        // A real socket is needed here: the injection helper does not parse
        // the request the way Node does.
        const response = await rawRequest(
            `GET /header HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Echo: value\r\nX-Injected: yes\r\n\r\n`,
            port,
        );

        // The line break ends the header, so the rest is a header of its own.
        // What matters is that nothing of it reaches the response headers.
        expect(response).not.toMatch(/x-injected/i);
        expect(response).toContain('{"value":"value"}');
    });

    it("answers a very long url with a client error", async () => {
        const response = await rawRequest(
            `GET /query?${"a".repeat(20_000)} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`,
            port,
        );

        expect(response).toMatch(/HTTP\/1\.1 4\d\d/);
    });

    it("answers an unknown method on a known route", async () => {
        const response = await app.inject({ method: "PUT", url: "/echo" });

        expect(response.statusCode).toBe(404);
        expect(response.json().error).toBeDefined();
    });

    it("answers a route with a null byte", async () => {
        const response = await app.inject({ method: "GET", url: "/echo%00" });

        expect(response.statusCode).toBeGreaterThanOrEqual(400);
    });

    it("keeps the error payload free of the stack trace by default", async () => {
        const response = await app.inject({ method: "GET", url: "/boom/42" });

        expect(response.statusCode).toBe(500);
        const body = response.json();
        expect(body.error).toBeDefined();
        expect(JSON.stringify(body)).not.toContain("at Object.");
    });

    it("survives a flood of malformed requests", async () => {
        const responses = await Promise.all(
            Array.from({ length: 100 }, (_, index) => app.inject({
                method: "POST",
                url: "/echo",
                headers: { "content-type": "application/json" },
                payload: index % 2 === 0 ? "{" : JSON.stringify({ index }),
            })),
        );

        for (const response of responses) {
            expect(response.statusCode).toBeLessThan(500);
        }

        // The server is still healthy afterwards.
        const health = await app.inject({ method: "GET", url: "/health" });
        expect([200, 404]).toContain(health.statusCode);
    });

    it("answers a request with a huge number of query parameters", async () => {
        const query = Array.from({ length: 500 }, (_, index) => `k${index}=v`).join("&");
        const response = await app.inject({ method: "GET", url: `/query?${query}` });

        expect(response.statusCode).toBe(200);
        expect(response.json().count).toBe(500);
    });
});
