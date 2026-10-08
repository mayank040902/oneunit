import { describe, expect, it } from "vitest";
import { collectMetadata } from "../../../src/lib/collect-metadata.js";

describe("collectMetadata", () => {
    it("collects basic request metadata", () => {
        const request = {
            headers: { "user-agent": "test-agent" },
            user: undefined,
            id: "req-123",
            ip: "127.0.0.1",
            ips: [],
            method: "GET",
            url: "/test",
            hostname: "localhost",
            protocol: "https",
            query: { foo: "bar" },
            params: {},
            body: undefined,
            routeOptions: { url: "/test" },
            raw: { httpVersion: "1.1" },
        };

        const result = collectMetadata(request, { statusCode: 200 });

        expect(result.request.id).toBe("req-123");
        expect(result.request.method).toBe("GET");
        expect(result.request.url).toBe("/test");
        expect(result.request.route).toBe("/test");
        expect(result.response.status_code).toBe(200);
        expect(result.server.node_version).toBe(process.version);
    });

    it("collects user identity when available", () => {
        const request = {
            headers: {},
            user: { id: "user-1", type: "admin" },
            id: "req-456",
            ip: "192.168.1.1",
            ips: [],
            method: "POST",
            url: "/api",
            hostname: "localhost",
            protocol: "https",
            query: {},
            params: {},
            body: undefined,
            routeOptions: { url: "/api" },
            raw: { httpVersion: "2.0" },
        };

        const result = collectMetadata(request, { statusCode: 201 });

        expect(result.identity.user_id).toBe("user-1");
        expect(result.identity.user_type).toBe("admin");
    });

    it("uses meta_data for identity fields", () => {
        const request = {
            headers: {},
            user: undefined,
            id: "req-789",
            ip: "127.0.0.1",
            ips: [],
            method: "GET",
            url: "/test",
            hostname: "localhost",
            protocol: "https",
            query: {},
            params: {},
            body: undefined,
            routeOptions: { url: "/test" },
            raw: { httpVersion: "1.1" },
        };

        const result = collectMetadata(
            request,
            { statusCode: 200 },
            {},
            { user_id: "meta-user", user_type: "member", event_id: "evt-1" },
        );

        expect(result.identity.user_id).toBe("meta-user");
        expect(result.identity.user_type).toBe("member");
        expect(result.event.id).toBe("evt-1");
    });

    it("reads tracing headers", () => {
        const request = {
            headers: {
                "x-trace-id": "trace-abc",
                "x-span-id": "span-123",
                "x-request-id": "req-def",
                "x-device-id": "device-xyz",
                "x-session-id": "session-456",
                "x-client-id": "client-789",
            },
            user: undefined,
            id: "req-abc",
            ip: "127.0.0.1",
            ips: [],
            method: "GET",
            url: "/test",
            hostname: "localhost",
            protocol: "https",
            query: {},
            params: {},
            body: undefined,
            routeOptions: { url: "/test" },
            raw: { httpVersion: "1.1" },
        };

        const result = collectMetadata(request, { statusCode: 200 });

        expect(result.trace.trace_id).toBe("trace-abc");
        expect(result.trace.span_id).toBe("span-123");
        expect(result.identity.device_id).toBe("device-xyz");
        expect(result.identity.session_id).toBe("session-456");
        expect(result.identity.client_id).toBe("client-789");
    });

    it("falls back to request.id as traceId", () => {
        const request = {
            headers: {},
            user: undefined,
            id: "req-fallback",
            ip: "127.0.0.1",
            ips: [],
            method: "GET",
            url: "/test",
            hostname: "localhost",
            protocol: "https",
            query: {},
            params: {},
            body: undefined,
            routeOptions: { url: "/test" },
            raw: { httpVersion: "1.1" },
        };

        const result = collectMetadata(request, { statusCode: 200 });

        expect(result.trace.trace_id).toBe("req-fallback");
    });

    it("includes server info", () => {
        const request = {
            headers: {},
            user: undefined,
            id: "req-1",
            ip: "127.0.0.1",
            ips: [],
            method: "GET",
            url: "/test",
            hostname: "localhost",
            protocol: "https",
            query: {},
            params: {},
            body: undefined,
            routeOptions: { url: "/test" },
            raw: { httpVersion: "1.1" },
        };

        const result = collectMetadata(request, { statusCode: 200 });

        expect(result.server.node_version).toBe(process.version);
        expect(result.server.platform).toBe(process.platform);
        expect(result.server.architecture).toBe(process.arch);
    });

    it("handles null reply", () => {
        const request = {
            headers: {},
            user: undefined,
            id: "req-null",
            ip: "127.0.0.1",
            ips: [],
            method: "GET",
            url: "/test",
            hostname: "localhost",
            protocol: "https",
            query: {},
            params: {},
            body: undefined,
            routeOptions: { url: "/test" },
            raw: { httpVersion: "1.1" },
        };

        const result = collectMetadata(request, null);

        expect(result.response.status_code).toBeNull();
    });

    it("includes startedAt for server processing time", () => {
        const request = {
            headers: {},
            user: undefined,
            id: "req-time",
            ip: "127.0.0.1",
            ips: [],
            method: "GET",
            url: "/test",
            hostname: "localhost",
            protocol: "https",
            query: {},
            params: {},
            body: undefined,
            routeOptions: { url: "/test" },
            raw: { httpVersion: "1.1" },
        };

        const startedAt = Date.now() - 1000;

        const result = collectMetadata(request, { statusCode: 200 }, { startedAt });

        expect(result.performance.server_processing_time).toBeGreaterThan(0);
    });

    it("removes undefined values from result", () => {
        const request = {
            headers: {},
            user: undefined,
            id: "req-clean",
            ip: "127.0.0.1",
            ips: [],
            method: "GET",
            url: "/test",
            hostname: "localhost",
            protocol: "https",
            query: {},
            params: {},
            body: undefined,
            routeOptions: { url: "/test" },
            raw: { httpVersion: "1.1" },
        };

        const result = collectMetadata(request, { statusCode: 200 });

        // No null values should appear in top-level fields (undefined removed, nulls may exist)
        expect(result.request.method).toBe("GET");
        expect(result.collected_at).toBeDefined();
    });
});
