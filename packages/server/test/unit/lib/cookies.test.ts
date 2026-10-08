import { describe, expect, it } from "vitest";
import {
    authCookieOptions,
    accessCookieOptions,
    refreshCookieOptions,
} from "../../../src/lib/cookies.js";

describe("Cookie Options", () => {
    describe("authCookieOptions", () => {
        it("has httpOnly set to true", () => {
            expect(authCookieOptions.httpOnly).toBe(true);
        });

        it("has sameSite set to strict", () => {
            expect(authCookieOptions.sameSite).toBe("strict");
        });

        it("has path set to /", () => {
            expect(authCookieOptions.path).toBe("/");
        });

        it("has maxAge of 7 days", () => {
            expect(authCookieOptions.maxAge).toBe(60 * 60 * 24 * 7);
        });

        it("has secure as a boolean", () => {
            expect(typeof authCookieOptions.secure).toBe("boolean");
        });
    });

    describe("accessCookieOptions", () => {
        it("has httpOnly set to true", () => {
            expect(accessCookieOptions.httpOnly).toBe(true);
        });

        it("has maxAge of 15 minutes", () => {
            expect(accessCookieOptions.maxAge).toBe(60 * 15);
        });

        it("has path set to /", () => {
            expect(accessCookieOptions.path).toBe("/");
        });

        it("has sameSite set to strict", () => {
            expect(accessCookieOptions.sameSite).toBe("strict");
        });
    });

    describe("refreshCookieOptions", () => {
        it("has httpOnly set to true", () => {
            expect(refreshCookieOptions.httpOnly).toBe(true);
        });

        it("has maxAge of 30 days", () => {
            expect(refreshCookieOptions.maxAge).toBe(60 * 60 * 24 * 30);
        });

        it("has path set to /auth", () => {
            expect(refreshCookieOptions.path).toBe("/auth");
        });

        it("has sameSite set to strict", () => {
            expect(refreshCookieOptions.sameSite).toBe("strict");
        });
    });

    describe("all cookies share common security properties", () => {
        it("all have httpOnly true", () => {
            expect(authCookieOptions.httpOnly).toBe(true);
            expect(accessCookieOptions.httpOnly).toBe(true);
            expect(refreshCookieOptions.httpOnly).toBe(true);
        });

        it("all use sameSite strict", () => {
            expect(authCookieOptions.sameSite).toBe("strict");
            expect(accessCookieOptions.sameSite).toBe("strict");
            expect(refreshCookieOptions.sameSite).toBe("strict");
        });
    });
});
