import process from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    envString,
    envNumber,
    envBool,
    envList,
    resolveNodeEnv,
    isDevelopment,
    isTest,
    isProduction,
    envFile,
} from "../../../src/config/env.js";

describe("envString", () => {
    beforeEach(() => {
        vi.stubEnv("TEST_VAR", "hello world");
    });

    it("returns env value", () => {
        expect(envString("TEST_VAR")).toBe("hello world");
    });

    it("returns fallback when unset", () => {
        expect(envString("UNSET_VAR", "fallback")).toBe("fallback");
    });

    it("returns fallback for empty string", () => {
        vi.stubEnv("EMPTY_VAR", "");
        expect(envString("EMPTY_VAR", "fallback")).toBe("fallback");
    });

    it("returns fallback for whitespace-only string", () => {
        vi.stubEnv("WS_VAR", "   ");
        expect(envString("WS_VAR", "fallback")).toBe("fallback");
    });

    it("trims surrounding whitespace", () => {
        vi.stubEnv("TRIM_VAR", "  value  ");
        expect(envString("TRIM_VAR")).toBe("value");
    });

    it("returns undefined when no fallback and unset", () => {
        expect(envString("UNSET_VAR")).toBeUndefined();
    });
});

describe("envNumber", () => {
    it("parses numeric env value", () => {
        vi.stubEnv("PORT", "3000");
        expect(envNumber("PORT")).toBe(3000);
    });

    it("returns fallback when unset", () => {
        expect(envNumber("UNSET_NUM", 8080)).toBe(8080);
    });

    it("returns fallback for invalid number", () => {
        vi.stubEnv("BAD_NUM", "not-a-number");
        expect(envNumber("BAD_NUM", 5000)).toBe(5000);
    });

    it("handles float values", () => {
        vi.stubEnv("FLOAT", "3.14");
        expect(envNumber("FLOAT")).toBe(3.14);
    });
});

describe("envBool", () => {
    it.each([
        ["true", true],
        ["1", true],
        ["yes", true],
        ["on", true],
        ["TRUE", true],
        ["Yes", true],
    ])("returns true for %s", (val, expected) => {
        vi.stubEnv("BOOL_VAR", val);
        expect(envBool("BOOL_VAR")).toBe(expected);
    });

    it.each([
        ["false", false],
        ["0", false],
        ["no", false],
        ["off", false],
        ["FALSE", false],
    ])("returns false for %s", (val, expected) => {
        vi.stubEnv("BOOL_VAR", val);
        expect(envBool("BOOL_VAR")).toBe(expected);
    });

    it("returns fallback when unset", () => {
        expect(envBool("UNSET_BOOL", true)).toBe(true);
    });

    it("returns fallback for invalid value", () => {
        vi.stubEnv("INVALID", "maybe");
        expect(envBool("INVALID", false)).toBe(false);
    });
});

describe("envList", () => {
    it("parses comma-separated values", () => {
        vi.stubEnv("LIST_VAR", "a,b,c");
        expect(envList("LIST_VAR")).toEqual(["a", "b", "c"]);
    });

    it("trims whitespace around items", () => {
        vi.stubEnv("LIST_VAR", " a , b , c ");
        expect(envList("LIST_VAR")).toEqual(["a", "b", "c"]);
    });

    it("filters empty items", () => {
        vi.stubEnv("LIST_VAR", "a,,b,");
        expect(envList("LIST_VAR")).toEqual(["a", "b"]);
    });

    it("returns fallback when unset", () => {
        expect(envList("UNSET_LIST", ["default"])).toEqual(["default"]);
    });
});

describe("resolveNodeEnv", () => {
    it("defaults to development when undefined", () => {
        expect(resolveNodeEnv(undefined)).toBe(
            process.env.NODE_ENV ? process.env.NODE_ENV.trim().toLowerCase() : "development",
        );
    });

    it("normalizes to lowercase", () => {
        expect(resolveNodeEnv("PRODUCTION")).toBe("production");
    });

    it("trims whitespace", () => {
        expect(resolveNodeEnv("  test  ")).toBe("test");
    });

    it("uses process.env.NODE_ENV when no arg provided", () => {
        vi.stubEnv("NODE_ENV", "production");
        expect(resolveNodeEnv()).toBe("production");
    });
});

describe("isDevelopment/isTest/isProduction", () => {
    it("detects development", () => {
        expect(isDevelopment("development")).toBe(true);
        expect(isDevelopment("production")).toBe(false);
    });

    it("detects test", () => {
        expect(isTest("test")).toBe(true);
        expect(isTest("development")).toBe(false);
    });

    it("detects production", () => {
        expect(isProduction("production")).toBe(true);
        expect(isProduction("development")).toBe(false);
    });
});

describe("envFile", () => {
    it("returns development env file path", () => {
        expect(envFile("/app", "development")).toBe("/app/.env.development");
    });

    it("returns production env file path", () => {
        expect(envFile("/app", "production")).toBe("/app/.env.production");
    });

    it("returns test env file path", () => {
        expect(envFile("/app", "test")).toBe("/app/.env.test");
    });

    it("defaults to development for unknown env", () => {
        expect(envFile("/app", "staging")).toBe("/app/.env.staging");
    });
});
