import { describe, expect, it } from "vitest";
import {
    DEFAULT_METADATA_LIMITS,
    DEFAULT_SENSITIVE_METADATA_KEYS,
    REDACTED_METADATA_VALUE,
    TRUNCATED_METADATA_VALUE,
    sanitizeMetadata,
} from "../../../src/plugins/core/response-metadata.js";

describe("sanitizeMetadata", () => {
    it("returns undefined for undefined input", () => {
        expect(sanitizeMetadata(undefined)).toBeUndefined();
    });

    it("does not mutate the input", () => {
        const input = { password: "hunter2", nested: { token: "abc" } };

        sanitizeMetadata(input);

        expect(input.password).toBe("hunter2");
        expect(input.nested.token).toBe("abc");
    });

    it("redacts sensitive keys", () => {
        const result = sanitizeMetadata({ password: "hunter2", email: "a@b.c" });

        expect(result?.password).toBe(REDACTED_METADATA_VALUE);
        expect(result?.email).toBe("a@b.c");
    });

    it("redacts case-insensitively", () => {
        const result = sanitizeMetadata({ Password: "hunter2", AccessToken: "abc" });

        expect(result?.Password).toBe(REDACTED_METADATA_VALUE);
        expect(result?.AccessToken).toBe(REDACTED_METADATA_VALUE);
    });

    it("redacts nested objects", () => {
        const result = sanitizeMetadata({
            submitted: { email: "a@b.c", password: "hunter2" },
        });

        expect((result?.submitted as Record<string, unknown>).password).toBe(REDACTED_METADATA_VALUE);
        expect((result?.submitted as Record<string, unknown>).email).toBe("a@b.c");
    });

    it("redacts inside arrays", () => {
        const result = sanitizeMetadata({
            users: [{ name: "Ada", secret: "s3cr3t" }],
        });

        const users = result?.users as Array<Record<string, unknown>>;
        expect(users[0].secret).toBe(REDACTED_METADATA_VALUE);
        expect(users[0].name).toBe("Ada");
    });

    it("covers every default sensitive key", () => {
        for (const key of DEFAULT_SENSITIVE_METADATA_KEYS) {
            const result = sanitizeMetadata({ [key]: "value" });
            expect(result?.[key]).toBe(REDACTED_METADATA_VALUE);
        }
    });

    it("does not redact when redaction is disabled", () => {
        const result = sanitizeMetadata({ password: "hunter2" }, { redact: false });

        expect(result?.password).toBe("hunter2");
    });

    it("redacts a custom key list", () => {
        const result = sanitizeMetadata(
            { apiKey: "abc", password: "hunter2" },
            { redact: ["apiKey"] },
        );

        expect(result?.apiKey).toBe(REDACTED_METADATA_VALUE);
        expect(result?.password).toBe("hunter2");
    });

    it("truncates long strings", () => {
        const result = sanitizeMetadata(
            { note: "x".repeat(50) },
            { limits: { maxStringLength: 10 } },
        );

        expect(result?.note).toBe(`${"x".repeat(10)}${TRUNCATED_METADATA_VALUE}`);
    });

    it("truncates long arrays", () => {
        const result = sanitizeMetadata(
            { items: [1, 2, 3, 4, 5] },
            { limits: { maxArrayLength: 2 } },
        );

        expect(result?.items).toEqual([1, 2, "[3 more]"]);
    });

    it("truncates objects with many keys", () => {
        const input = Object.fromEntries(
            Array.from({ length: 5 }, (_, index) => [`key${index}`, index]),
        );

        const result = sanitizeMetadata(input, { limits: { maxKeys: 2 } });

        expect(result).toEqual({ key0: 0, key1: 1, "[truncatedKeys]": 3 });
    });

    it("replaces circular references with a marker", () => {
        const input: Record<string, unknown> = { name: "root" };
        input.self = input;

        const result = sanitizeMetadata(input);

        expect(result?.self).toBe("[Circular]");
    });

    it("replaces values past the depth limit with a marker", () => {
        const result = sanitizeMetadata(
            { a: { b: { c: { d: "deep" } } } },
            { limits: { maxDepth: 2 } },
        );

        expect(JSON.stringify(result)).toContain("[Object]");
    });

    it("keeps values that serialise themselves", () => {
        const date = new Date("2026-01-01T00:00:00.000Z");

        const result = sanitizeMetadata({ at: date });

        expect(result?.at).toBe(date);
    });

    it("keeps non-object primitives", () => {
        const result = sanitizeMetadata({
            count: 3,
            ok: true,
            missing: null,
        });

        expect(result).toEqual({ count: 3, ok: true, missing: null });
    });

    it("ignores non-positive limits", () => {
        const result = sanitizeMetadata(
            { note: "x".repeat(DEFAULT_METADATA_LIMITS.maxStringLength + 10) },
            { limits: { maxStringLength: 0, maxKeys: -1 } },
        );

        expect(result?.note).toBe(
            `${"x".repeat(DEFAULT_METADATA_LIMITS.maxStringLength)}${TRUNCATED_METADATA_VALUE}`,
        );
    });
});
