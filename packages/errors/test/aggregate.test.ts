import { describe, it, expect, vi } from "vitest";
import {
  AggregateAppError,
  AppError,
  InternalError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  TimeoutError,
  getAggregateErrors,
  getRetryAfter,
  getRootCause,
  getErrorChain,
  isAggregateError,
  isRetryable,
  formatError,
  serializeError,
  deserializeError,
  sanitizeDetails,
  redactDetails,
  DEFAULT_DETAIL_LIMITS,
  REDACTED,
  TRUNCATED,
  combineAll,
  tryAllSettled,
  withRetry,
  ok,
  err,
  isErr,
  createErrorHandler,
} from "../src/index.js";

describe("AggregateAppError", () => {
  it("keeps every sub-error, in order", () => {
    const members = [new Error("first"), new Error("second"), new Error("third")];
    const aggregate = new AggregateAppError("3 of 3 operations failed", members);

    expect(aggregate.errors).toEqual(members);
    expect(aggregate.summary).toEqual(["first", "second", "third"]);
    expect(isAggregateError(aggregate)).toBe(true);
    expect(isAggregateError(new Error("plain"))).toBe(false);
  });

  it("reports the most severe member status", () => {
    expect(new AggregateAppError("m", [new ValidationError("v", {})]).statusCode).toBe(400);
    expect(new AggregateAppError("m", [
      new ValidationError("v", {}),
      new InternalError("boom"),
    ]).statusCode).toBe(500);
    expect(new AggregateAppError("m", []).statusCode).toBe(500);
  });

  it("is an AppError with the AGGREGATE_ERROR code", () => {
    const aggregate = new AggregateAppError("m", [new Error("a")]);
    expect(aggregate).toBeInstanceOf(AppError);
    expect(aggregate.code).toBe("AGGREGATE_ERROR");
    expect(aggregate.toJSON().errors).toHaveLength(1);
  });

  it("reads the sub-errors of a platform AggregateError", () => {
    const native = new AggregateError([new Error("a"), new Error("b")], "Promise.any failed");
    expect(isAggregateError(native)).toBe(true);
    expect(getAggregateErrors(native)).toHaveLength(2);
  });
});

describe("formatError with aggregates", () => {
  it("does not discard a platform AggregateError's members", () => {
    const native = new AggregateError([new Error("db down"), new Error("cache down")], "3 operations failed");

    const payload = formatError(native, { includeStack: false });
    expect(payload.message).toBe("3 operations failed");
    expect(payload.errors).toHaveLength(2);
    // Members are raw by default so nothing is silently reshaped.
    expect((payload.errors as Error[])[0].message).toBe("db down");
  });

  it("recursively formats members with includeAggregated", () => {
    const native = new AggregateError([new ValidationError("bad", { email: ["required"] })], "failed");
    const payload = formatError(native, { includeStack: false, includeAggregated: true });

    const member = (payload.errors as Record<string, unknown>[])[0];
    expect(member.code).toBe("VALIDATION_ERROR");
    expect(member.statusCode).toBe(400);
    expect(member.stack).toBeUndefined();
  });

  it("survives a serialization round trip with its members", () => {
    const original = new AggregateAppError("batch failed", [
      new ValidationError("bad email", { email: ["required"] }),
      new NotFoundError("User", 7),
    ]);

    const restored = deserializeError(JSON.parse(JSON.stringify(serializeError(original))));

    expect(restored).toBeInstanceOf(AggregateAppError);
    const aggregate = restored as AggregateAppError;
    expect(aggregate.errors).toHaveLength(2);
    expect((aggregate.errors[0] as AppError).code).toBe("VALIDATION_ERROR");
    expect((aggregate.errors[1] as AppError).code).toBe("NOT_FOUND");
  });

  it("is retryable if any member is", () => {
    expect(isRetryable(new AggregateAppError("m", [
      new ValidationError("v", {}),
      new InternalError("timeout"),
    ]))).toBe(true);

    expect(isRetryable(new AggregateAppError("m", [
      new ValidationError("v", {}),
      new NotFoundError("User", 1),
    ]))).toBe(false);
  });

  it("walks into members for the root cause and the chain", () => {
    const root = new Error("ECONNREFUSED");
    const aggregate = new AggregateAppError("batch", [new ValidationError("v", {}), root]);

    expect(getRootCause(aggregate)).toBe(root);

    const messages = getErrorChain(aggregate).map(e => e.message);
    expect(messages).toContain("root");
    expect(messages).toContain("v");
  });
});

describe("combineAll and tryAllSettled", () => {
  it("keeps every failure rather than the first", () => {
    const result = combineAll([
      err(new Error("first")),
      ok(2),
      err(new Error("second")),
      err(new Error("third")),
    ]);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(AggregateAppError);
      expect(result.error.summary).toEqual(["first", "second", "third"]);
      expect(result.error.message).toBe("3 of 4 operations failed");
    }
  });

  it("returns all values when nothing failed", () => {
    expect(combineAll([ok(1), ok(2)])).toEqual({ ok: true, value: [1, 2] });
    expect(combineAll([])).toEqual({ ok: true, value: [] });
  });

  it("uses the lone failure's message when only one failed", () => {
    const result = combineAll([ok(1), err(new Error("only one"))]);
    expect(isErr(result) && result.error.message).toBe("only one");
  });

  it("settles every promise and keeps all failures", async () => {
    const result = await tryAllSettled([
      Promise.reject(new Error("a")),
      Promise.resolve(2),
      Promise.reject(new Error("b")),
    ]);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.summary).toEqual(["a", "b"]);
  });

  it("passes values through typed", async () => {
    const result = await tryAllSettled([Promise.resolve(1), Promise.resolve(2)]);
    expect(result).toEqual({ ok: true, value: [1, 2] });
  });
});

describe("getRetryAfter", () => {
  it("reads seconds from AppError details", () => {
    expect(getRetryAfter(new RateLimitError("slow", 30))).toBe(30_000);
    expect(getRetryAfter(new RateLimitError("slow", 1.5))).toBe(1500);
    expect(getRetryAfter(new RateLimitError("slow"))).toBeUndefined();
  });

  it("reads a Retry-After header in seconds or as an HTTP date", () => {
    expect(getRetryAfter({ headers: { "retry-after": "30" } })).toBe(30_000);
    expect(getRetryAfter({ headers: { "Retry-After": 12 } })).toBe(12_000);

    const future = new Date(Date.now() + 60_000).toUTCString();
    const delta = getRetryAfter({ headers: { "retry-after": future } });
    expect(delta).toBeGreaterThan(50_000);
    expect(delta).toBeLessThanOrEqual(60_000);
  });

  it("reads retryAfterMs and a bare retryAfter", () => {
    expect(getRetryAfter(Object.assign(new Error("x"), { retryAfterMs: 250 }))).toBe(250);
    expect(getRetryAfter(Object.assign(new Error("x"), { retryAfter: 5 }))).toBe(5000);
  });

  it("treats a past HTTP date and garbage as no instruction", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(getRetryAfter({ headers: { "retry-after": past } })).toBe(0);
    expect(getRetryAfter({ headers: { "retry-after": "soon" } })).toBeUndefined();
    expect(getRetryAfter({ headers: { "retry-after": "" } })).toBeUndefined();
    expect(getRetryAfter({ headers: { "retry-after": -5 } })).toBeUndefined();
  });

  it("returns undefined for an ordinary error", () => {
    expect(getRetryAfter(new Error("plain"))).toBeUndefined();
    expect(getRetryAfter(undefined)).toBeUndefined();
  });
});

describe("withRetry respects Retry-After", () => {
  it("waits for the server, not the local backoff", async () => {
    const fn = vi.fn(async () => {
      throw new RateLimitError("slow down", 0.06); // 60ms
    });

    const started = Date.now();
    await expect(
      withRetry(fn, { maxAttempts: 2, delay: 1, backoff: 1 })
    ).rejects.toThrow("slow down");

    expect(fn).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  it("can be turned off", async () => {
    const fn = vi.fn(async () => {
      throw new RateLimitError("slow down", 10); // 10s, must not be waited
    });

    const started = Date.now();
    await expect(
      withRetry(fn, { maxAttempts: 2, delay: 1, backoff: 1, respectRetryAfter: false })
    ).rejects.toThrow("slow down");
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("gives up rather than exceeding the budget", async () => {
    const fn = vi.fn(async () => {
      throw new RateLimitError("slow down", 30);
    });

    await expect(
      withRetry(fn, { maxAttempts: 5, delay: 1, maxTotalDelay: 50 })
    ).rejects.toThrow(/Retry budget exhausted/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("takes the longer of backoff and Retry-After", async () => {
    const delays: number[] = [];
    const fn = vi.fn(async () => {
      throw new RateLimitError("slow down", 0.05);
    });

    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        delay: 200,
        backoff: 1,
        onRetry: (_e, _a, ms) => delays.push(ms),
      })
    ).rejects.toThrow("slow down");

    // Local backoff asked for 200ms; the server asked for 50ms. The longer wins.
    expect(delays).toEqual([200, 200]);
  });
});

describe("detail limits", () => {
  it("truncates long strings", () => {
    const out = sanitizeDetails({ blob: "x".repeat(5000) }, { limits: { maxStringLength: 100 } });
    const blob = out!.blob as string;
    expect(blob.length).toBe(100 + TRUNCATED.length);
    expect(blob.endsWith(TRUNCATED)).toBe(true);
  });

  it("caps array length and counts the remainder", () => {
    const out = sanitizeDetails({ items: Array.from({ length: 250 }, (_, i) => i) }, {
      limits: { maxArrayLength: 10 },
    });
    const items = out!.items as unknown[];
    expect(items).toHaveLength(11);
    expect(items[10]).toBe("[240 more]");
  });

  it("caps key count and records how many were dropped", () => {
    const wide = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i]));
    const out = sanitizeDetails(wide, { limits: { maxKeys: 10 } });
    expect(Object.keys(out!).length).toBe(11);
    expect(out!["[truncatedKeys]"]).toBe(50);
  });

  it("bounds nesting depth", () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 40; i++) deep = { child: deep };
    const out = sanitizeDetails({ deep }, { limits: { maxDepth: 3 } });
    expect(JSON.stringify(out)).toContain("[Object]");
  });

  it("applies DEFAULT_DETAIL_LIMITS when no limits are given", () => {
    const out = sanitizeDetails({ blob: "x".repeat(DEFAULT_DETAIL_LIMITS.maxStringLength + 10) });
    expect((out!.blob as string).endsWith(TRUNCATED)).toBe(true);
  });

  it("ignores a nonsensical limit instead of disabling the bound", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = sanitizeDetails({ blob: "x".repeat(5000) }, { limits: { maxStringLength: bad } });
      expect((out!.blob as string).length).toBeGreaterThan(100);
    }
  });

  it("redacts and truncates in the same pass", () => {
    const out = sanitizeDetails(
      { password: "hunter2", list: Array.from({ length: 100 }, () => "y".repeat(500)) },
      { redact: true, limits: { maxStringLength: 10, maxArrayLength: 3 } }
    );
    expect(out!.password).toBe(REDACTED);
    expect((out!.list as unknown[])).toHaveLength(4);
  });

  it("does not mutate the input and still handles cycles", () => {
    const cyclic: Record<string, unknown> = { password: "p" };
    cyclic.self = cyclic;
    const out = sanitizeDetails(cyclic, { redact: true });
    expect(cyclic.password).toBe("p");
    expect(out!.self).toBe("[Circular]");
  });

  it("keeps redactDetails working as a wrapper", () => {
    expect(redactDetails({ token: "t" }, ["token"])!.token).toBe(REDACTED);
  });

  it("limits the details that formatError emits", () => {
    const error = new AppError("m", "C", 500, { blob: "x".repeat(100_000) });
    const payload = formatError(error, { includeStack: false, limits: { maxStringLength: 50 } });
    expect((payload.details as Record<string, string>).blob.endsWith(TRUNCATED)).toBe(true);
    expect(JSON.stringify(payload).length).toBeLessThan(200);
  });
});

describe("log path redaction and limits", () => {
  it("masks details in the log line, not only the response", async () => {
    const errorLog = vi.fn();
    const handler = createErrorHandler({ logErrors: true, redactDetails: true });

    const reply = {
      sent: false,
      statusCode: 0,
      status(code: number) { this.statusCode = code; return this; },
      send(payload: unknown) { this.payload = payload; return this; },
    };
    const request = { url: "/x", method: "GET", id: "r1", log: { warn: vi.fn(), error: errorLog } };

    await handler(
      new AppError("failed", "C", 500, { password: "hunter2", blob: "x".repeat(50_000) }) as never,
      request as never,
      reply as never
    );

    expect(errorLog).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(errorLog.mock.calls[0][0].err);
    expect(logged).not.toContain("hunter2");
    expect(logged).toContain("[REDACTED]");
    expect(logged).toContain(TRUNCATED);
  });

  it("hands pino the real Error when redaction is off", async () => {
    const errorLog = vi.fn();
    const handler = createErrorHandler({ logErrors: true });

    const reply = {
      sent: false,
      status: () => reply,
      send: () => reply,
    };
    const request = { url: "/x", method: "GET", id: "r1", log: { warn: vi.fn(), error: errorLog } };

    await handler(new ValidationError("bad", {}) as never, request as never, reply as never);

    expect(errorLog.mock.calls[0][0].err).toBeInstanceOf(AppError);
  });

  it("passes an AggregateError through with its members", async () => {
    const handler = createErrorHandler({ logErrors: false });

    const reply = {
      sent: false,
      statusCode: 0,
      status(code: number) { this.statusCode = code; return this; },
      send(payload: unknown) { this.payload = payload; return this; },
    };
    const request = { url: "/x", method: "GET", id: "r1", log: { warn: vi.fn(), error: vi.fn() } };

    await handler(
      new AggregateError([new Error("db down"), new Error("cache down")], "batch failed") as never,
      request as never,
      reply as never
    );

    const body = reply.payload as { error: { errors: unknown[]; statusCode: number } };
    expect(reply.statusCode).toBe(500);
    expect(body.error.errors).toHaveLength(2);
  });

  it("caps a huge validation payload in the response", async () => {
    const handler = createErrorHandler({ logErrors: false, detailLimits: { maxKeys: 5 } });

    const reply = {
      sent: false,
      statusCode: 0,
      status(code: number) { this.statusCode = code; return this; },
      send(payload: unknown) { this.payload = payload; return this; },
    };
    const request = { url: "/x", method: "GET", id: "r1", log: { warn: vi.fn(), error: vi.fn() } };

    const fields = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`f${i}`, ["bad"]]));
    await handler(new ValidationError("bad", fields) as never, request as never, reply as never);

    const body = reply.payload as { error: { details: { fields: Record<string, unknown> } } };
    expect(Object.keys(body.error.details.fields).length).toBe(6);
  });
});

describe("AggregateAppError in withRetry budget", () => {
  it("retries an aggregate and surfaces the TimeoutError when spent", async () => {
    const fn = vi.fn(async () => {
      throw new AggregateAppError("batch", [new RateLimitError("slow", 5)]);
    });

    await expect(withRetry(fn, { maxAttempts: 3, delay: 1, maxTotalDelay: 10 })).rejects.toThrow(
      TimeoutError
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });
});