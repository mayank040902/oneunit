import { describe, it, expect } from "vitest";
import {
  AppError,
  InternalError,
  NotFoundError,
  ValidationError,
  RateLimitError,
  ERROR_REGISTRY,
  serializeError,
  deserializeError,
  redactDetails,
  formatError,
  getRootCause,
  getErrorChain,
  isRetryable,
  REDACTED,
} from "../src/index.js";

describe("serializeError / deserializeError", () => {
  it("round-trips an AppError through JSON", () => {
    const original = new NotFoundError("User", 42);
    const wire = JSON.parse(JSON.stringify(serializeError(original)));

    expect(wire).not.toBeInstanceOf(Error);
    expect(wire.code).toBe("NOT_FOUND");
    expect(wire.statusCode).toBe(404);

    const restored = deserializeError(wire);
    expect(restored).toBeInstanceOf(AppError);
    expect(restored?.name).toBe("NotFoundError");
    expect((restored as AppError).code).toBe("NOT_FOUND");
    expect((restored as AppError).statusCode).toBe(404);
    expect((restored as AppError).details?.resource).toBe("User");
    expect(restored?.message).toBe('User with id "42" not found');
    // The whole point: instanceof and isAppError work again after the hop.
    expect(isAppErrorValue(restored)).toBe(true);
  });

  it("round-trips the cause chain", () => {
    const root = new Error("ECONNREFUSED");
    const original = new InternalError("query failed", root, { attempt: 1 });

    const restored = deserializeError(serializeError(original));

    expect(restored?.cause).toBeInstanceOf(Error);
    expect(restored?.cause?.message).toBe("ECONNREFUSED");
  });

  it("restores a registered class name for several codes", () => {
    for (const code of Object.keys(ERROR_REGISTRY)) {
      const restored = deserializeError({ name: "X", message: "m", code, statusCode: 500 });
      expect(restored?.name).toBe(ERROR_REGISTRY[code].name);
      expect((restored as AppError).code).toBe(code);
    }
  });

  it("keeps code, status and details for an unregistered code", () => {
    const restored = deserializeError({
      name: "VendorError",
      message: "upstream exploded",
      code: "VENDOR_SPECIFIC",
      statusCode: 503,
      details: { vendor: "acme" },
    }) as AppError;

    expect(restored.code).toBe("VENDOR_SPECIFIC");
    expect(restored.statusCode).toBe(503);
    expect(restored.details).toEqual({ vendor: "acme" });
    expect(restored.name).toBe("VendorError");
  });

  it("rebuilds through AppError.fromJSON", () => {
    const restored = AppError.fromJSON(serializeError(new ValidationError("bad", { a: ["required"] })));
    expect(restored?.name).toBe("ValidationError");
    expect((restored as AppError).details?.fields).toEqual({ a: ["required"] });
  });

  it("returns undefined for input that is not a serialized error", () => {
    expect(deserializeError(undefined)).toBeUndefined();
    expect(deserializeError(null)).toBeUndefined();
    expect(deserializeError("nope")).toBeUndefined();
    expect(deserializeError({})).toBeUndefined();
    expect(deserializeError({ name: "OnlyName" })).toBeUndefined();
  });

  it("does not throw on an impossible serialized statusCode", () => {
    const restored = deserializeError({ name: "E", message: "m", code: "NOT_FOUND", statusCode: 9999 });
    expect((restored as AppError).statusCode).toBe(500);
  });

  it("omits the stack by default and includes it on request", () => {
    expect(serializeError(new InternalError("m")).stack).toBeUndefined();
    expect(typeof serializeError(new InternalError("m"), { includeStack: true }).stack).toBe("string");
  });

  it("truncates a chain deeper than maxDepth", () => {
    let deepest = new Error("depth 5");
    for (let i = 0; i < 5; i++) deepest = new InternalError(`depth ${i}`, deepest);

    const wire = serializeError(deepest, { maxDepth: 3 });
    let node = wire.cause as Record<string, unknown>;
    let depth = 1;
    while (node) {
      node = node.cause as Record<string, unknown>;
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(4);
    expect(node).toBeUndefined();
  });

  it("serializes a non-error value as a string", () => {
    expect(serializeError("plain string")).toBe("plain string");
  });
});

describe("redactDetails", () => {
  it("masks default sensitive keys case-insensitively", () => {
    const redacted = redactDetails({
      Password: "hunter2",
      apiKey: "k",
      nested: { accessToken: "t", safe: "yes" },
      list: [{ token: "x" }, "plain"],
    });

    expect(redacted?.Password).toBe(REDACTED);
    expect(redacted?.apiKey).toBe(REDACTED);
    expect((redacted?.nested as Record<string, unknown>).accessToken).toBe(REDACTED);
    expect((redacted?.nested as Record<string, unknown>).safe).toBe("yes");
    expect((redacted?.list as Record<string, unknown>[])[0].token).toBe(REDACTED);
    expect((redacted?.list as unknown[])[1]).toBe("plain");
  });

  it("accepts a custom key list", () => {
    const redacted = redactDetails({ password: "p", email: "e" }, ["email"]);
    expect(redacted?.email).toBe(REDACTED);
    expect(redacted?.password).toBe("p");
  });

  it("passes undefined through", () => {
    expect(redactDetails(undefined)).toBeUndefined();
  });

  it("survives cycles instead of overflowing", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    const redacted = redactDetails(cyclic);
    expect(redacted?.self).toBe("[Circular]");
  });

  it("stops at maxDepth instead of recursing forever", () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 30; i++) deep = { child: deep };
    expect(() => redactDetails(deep)).not.toThrow();
  });

  it("does not mutate the input", () => {
    const details = { password: "hunter2" };
    redactDetails(details);
    expect(details.password).toBe("hunter2");
  });
});

describe("formatError options", () => {
  it("masks details when redact is enabled", () => {
    const error = new AppError("db down", "DATABASE_ERROR", 500, { password: "hunter2", host: "db-1" });
    const plain = formatError(error);
    const redacted = formatError(error, { redact: true });

    expect((plain.details as Record<string, unknown>).password).toBe("hunter2");
    expect((redacted.details as Record<string, unknown>).password).toBe(REDACTED);
    expect((redacted.details as Record<string, unknown>).host).toBe("db-1");
  });

  it("includes the cause chain only on request", () => {
    const error = new InternalError("wrapped", new Error("root cause"));

    expect(formatError(error).cause).toBeUndefined();
    expect(formatError(error, { includeCause: true }).cause).toMatchObject({ message: "root cause" });
  });

  it("omits the stack when includeStack is false", () => {
    expect(formatError(new InternalError("m")).stack).toBeDefined();
    expect(formatError(new InternalError("m"), { includeStack: false }).stack).toBeUndefined();
  });
});

describe("cause traversal", () => {
  it("finds the deepest cause", () => {
    const root = new Error("root");
    expect(getRootCause(new InternalError("a", new InternalError("b", root)))).toBe(root);
  });

  it("returns the error itself when it has no cause", () => {
    const error = new InternalError("only");
    expect(getRootCause(error)).toBe(error);
  });

  it("returns undefined for non-errors", () => {
    expect(getRootCause("nope")).toBeUndefined();
    expect(getErrorChain("nope")).toEqual([]);
  });

  it("lists the chain nearest first", () => {
    const root = new Error("root");
    const chain = getErrorChain(new InternalError("a", new InternalError("b", root)));
    expect(chain.map(e => e.message)).toEqual(["a", "b", "root"]);
  });

  it("does not loop forever on a cyclic cause chain", () => {
    const first = new InternalError("first");
    const second = new InternalError("second", first);
    Object.defineProperty(first, "cause", { value: second, configurable: true });

    expect(getErrorChain(first).length).toBeLessThanOrEqual(3);
    expect(getRootCause(first)).toBeDefined();
  });
});

describe("isRetryable", () => {
  it("treats server faults and throttling as retryable", () => {
    expect(isRetryable(new InternalError("m"))).toBe(true);
    expect(isRetryable(new RateLimitError("slow"))).toBe(true);
    expect(isRetryable(Object.assign(new Error("x"), { statusCode: 503 }))).toBe(true);
    expect(isRetryable(Object.assign(new Error("x"), { statusCode: 408 }))).toBe(true);
  });

  it("treats client mistakes as not retryable", () => {
    expect(isRetryable(new ValidationError("bad", {}))).toBe(false);
    expect(isRetryable(new NotFoundError("User", 1))).toBe(false);
  });
});

// Local helper so this file does not depend on the widened isAppError guard
// while still asserting the round-trip property that matters.
function isAppErrorValue(value: unknown): boolean {
  return value instanceof AppError;
}