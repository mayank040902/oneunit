import { describe, expect, it } from "vitest";
import {
    DEFAULT_BUILTIN_PLUGINS,
    mergeBuiltinPlugins,
} from "../../src/plugins/index.js";

describe("mergeBuiltinPlugins", () => {
    it("keeps the default siblings of a key the caller sets", () => {
        const merged = mergeBuiltinPlugins({ cors: { origin: ["https://example.com"] } });

        expect(merged.cors).toEqual({
            origin: ["https://example.com"],
            credentials: true,
        });
    });

    it("keeps the default error handler options", () => {
        const merged = mergeBuiltinPlugins({ errorHandler: { includeStack: true } });

        expect(merged.errorHandler).toEqual({
            includeStack: true,
            logErrors: true,
        });
    });

    it("lets a later layer override an earlier one", () => {
        const merged = mergeBuiltinPlugins(
            { cors: { origin: ["https://first.example"] } },
            { cors: { origin: ["https://second.example"] } },
        );

        expect(merged.cors).toEqual({
            origin: ["https://second.example"],
            credentials: true,
        });
    });

    it("replaces a default object with a boolean", () => {
        const merged = mergeBuiltinPlugins({ swagger: true });

        expect(merged.swagger).toBe(true);
        expect(merged.swaggerUI).toBe(DEFAULT_BUILTIN_PLUGINS.swaggerUI);
    });

    it("keeps a false value instead of merging it with the default", () => {
        const merged = mergeBuiltinPlugins({ cors: false });

        expect(merged.cors).toBe(false);
    });

    it("ignores undefined values in a layer", () => {
        const merged = mergeBuiltinPlugins({ cors: undefined, helmet: undefined });

        expect(merged.cors).toEqual(DEFAULT_BUILTIN_PLUGINS.cors);
        expect(merged.helmet).toEqual(DEFAULT_BUILTIN_PLUGINS.helmet);
    });
});
