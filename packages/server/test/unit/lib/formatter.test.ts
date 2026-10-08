import { describe, expect, it } from "vitest";
import { formatBytes, formatTime, timestamp } from "../../../src/lib/formatter.js";

describe("formatBytes", () => {
    it("formats zero bytes", () => {
        expect(formatBytes(0)).toBe("0 Bytes");
    });

    it("formats 1 KB", () => {
        expect(formatBytes(1024)).toBe("1 KB");
    });

    it("formats 1.5 KB", () => {
        expect(formatBytes(1536)).toBe("1.5 KB");
    });

    it("formats 1 MB", () => {
        expect(formatBytes(1048576)).toBe("1 MB");
    });

    it("formats 1 GB", () => {
        expect(formatBytes(1073741824)).toBe("1 GB");
    });

    it("formats 1 TB", () => {
        expect(formatBytes(1099511627776)).toBe("1 TB");
    });

    it("respects decimals parameter", () => {
        expect(formatBytes(1536, 0)).toBe("2 KB");
        expect(formatBytes(1536, 2)).toBe("1.5 KB");
        expect(formatBytes(1536, 4)).toBe("1.5 KB");
    });

    it("throws on non-finite input", () => {
        expect(() => formatBytes(NaN)).toThrow("Bytes must be a finite number");
        expect(() => formatBytes(Infinity)).toThrow("Bytes must be a finite number");
    });

    it("throws on negative input", () => {
        expect(() => formatBytes(-1)).toThrow("Bytes must be positive");
    });
});

describe("formatTime", () => {
    it("formats milliseconds", () => {
        expect(formatTime(25)).toBe("25ms");
    });

    it("formats seconds", () => {
        expect(formatTime(1500)).toBe("1.5s");
    });

    it("formats minutes", () => {
        expect(formatTime(90000)).toBe("1.5m");
    });

    it("formats hours", () => {
        expect(formatTime(7200000)).toBe("2h");
    });

    it("formats days", () => {
        expect(formatTime(172800000)).toBe("2d");
    });

    it("formats years", () => {
        expect(formatTime(31536000000)).toBe("1y");
    });

    it("throws on non-finite input", () => {
        expect(() => formatTime(NaN)).toThrow("Time must be a finite number");
    });

    it("throws on negative input", () => {
        expect(() => formatTime(-1)).toThrow("Time must be positive");
    });

    it("formats 0ms as 0ms", () => {
        expect(formatTime(0)).toBe("0ms");
    });
});

describe("timestamp", () => {
    it("formats a Date to ISO string", () => {
        const date = new Date("2022-01-01T00:00:00.000Z");
        expect(timestamp(date)).toBe("2022-01-01T00:00:00.000Z");
    });

    it("throws on non-Date input", () => {
        expect(() => timestamp("2022-01-01" as unknown as Date)).toThrow(
            "Data must be a Date object",
        );
    });

    it("throws on invalid type", () => {
        expect(() => timestamp({} as unknown as Date)).toThrow("Data must be a Date object");
    });
});
