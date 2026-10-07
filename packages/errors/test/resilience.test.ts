import { describe, it, expect, vi } from "vitest";
import {
  withRetry,
  withTimeout,
  AbortError,
  ok,
  err,
  match,
  fold,
  tap,
  collect,
  unwrapOrElse,
  andThenAsync,
  collectAsync,
  InternalError,
  ValidationError,
  NotFoundError,
} from "../src/index.js";

describe("withRetry cancellation", () => {
  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const fn = vi.fn(async () => "never");
    await expect(withRetry(fn, { signal: controller.signal, delay: 1 })).rejects.toThrow(AbortError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("stops retrying when aborted mid-backoff", async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      throw new InternalError("boom");
    });

    const pending = withRetry(fn, { maxAttempts: 5, delay: 50, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);

    await expect(pending).rejects.toThrow(AbortError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("keeps the platform abort reason as the cause", async () => {
    const controller = new AbortController();
    const reason = new Error("shutdown requested");
    const fn = vi.fn(async () => {
      controller.abort(reason);
      throw new InternalError("boom");
    });

    const error = await withRetry(fn, { maxAttempts: 3, delay: 1, signal: controller.signal }).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(AbortError);
    expect((error as AbortError).cause).toBe(reason);
  });
});

describe("withRetry budget and options", () => {
  it("caps a single delay at maxDelay", async () => {
    const fn = vi.fn(async () => {
      throw new InternalError("boom");
    });

    const started = Date.now();
    await expect(withRetry(fn, { maxAttempts: 4, delay: 1000, backoff: 10, maxDelay: 20 })).rejects.toThrow("boom");
    // Four attempts with a 20ms ceiling: 20 + 20 + 20 sleeps.
    expect(Date.now() - started).toBeLessThan(400);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("gives up with a TimeoutError once maxTotalDelay is exhausted", async () => {
    const fn = vi.fn(async () => {
      throw new InternalError("boom");
    });

    await expect(
      withRetry(fn, { maxAttempts: 10, delay: 40, backoff: 1, maxTotalDelay: 50 })
    ).rejects.toThrow(/Retry budget exhausted/);
    expect(fn.mock.calls.length).toBeLessThan(10);
  });

  it("applies jitter within [delay/2, delay]", async () => {
    const delays: number[] = [];
    const fn = vi.fn(async () => {
      throw new InternalError("boom");
    });

    await expect(
      withRetry(fn, {
        maxAttempts: 6,
        delay: 100,
        backoff: 1,
        jitter: true,
        onRetry: (_error, _attempt, delayMs) => delays.push(delayMs),
      })
    ).rejects.toThrow("boom");

    expect(delays).toHaveLength(5);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(50);
      expect(delay).toBeLessThanOrEqual(100);
    }
  });

  it("defaults shouldRetry to isRetryable, so 4xx is not retried", async () => {
    const fn = vi.fn(async () => {
      throw new NotFoundError("User", 1);
    });

    await expect(withRetry(fn, { maxAttempts: 5, delay: 1 })).rejects.toThrow("not found");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries 5xx by default", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new InternalError("transient");
        return "ok";
      },
      { maxAttempts: 5, delay: 1 }
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });
});

describe("withTimeout cancellation", () => {
  it("rejects when the signal aborts before the deadline", async () => {
    const controller = new AbortController();
    const pending = withTimeout(new Promise(r => setTimeout(r, 500)), 5000, "slow", {
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toThrow(AbortError);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      withTimeout(new Promise(r => setTimeout(r, 50)), 5000, "slow", { signal: controller.signal })
    ).rejects.toThrow(AbortError);
  });

  it("still resolves normally when the signal never fires", async () => {
    const controller = new AbortController();
    await expect(
      withTimeout(Promise.resolve("fast"), 500, "slow", { signal: controller.signal })
    ).resolves.toBe("fast");
  });
});

describe("Result algebra additions", () => {
  it("unwrapOrElse recovers using the error", () => {
    expect(unwrapOrElse(err(new ValidationError("bad", {})), e => e.message)).toBe("bad");
    expect(unwrapOrElse(ok(7), () => "unused")).toBe(7);
  });

  it("match and fold dispatch to the right branch", () => {
    const handlers = { ok: (v: number) => `ok:${v}`, err: (e: Error) => `err:${e.message}` };
    expect(match(ok(1), handlers)).toBe("ok:1");
    expect(match(err(new Error("x")), handlers)).toBe("err:x");
    expect(fold(ok(2), handlers)).toBe("ok:2");
  });

  it("tap runs for its side effect without changing the result", () => {
    const seen: number[] = [];
    expect(tap(ok(1), v => seen.push(v))).toEqual({ ok: true, value: 1 });
    expect(tap(err(new Error("x")), () => seen.push(99))).toEqual({ ok: false, error: expect.any(Error) });
    expect(seen).toEqual([1]);
  });

  it("collect returns the first error in order", () => {
    expect(collect([ok(1), ok(2)])).toEqual({ ok: true, value: [1, 2] });
    expect(collect([])).toEqual({ ok: true, value: [] });

    const failure = collect([ok(1), err(new ValidationError("b", {})), ok(3)]);
    expect(failure.ok).toBe(false);
  });

  it("andThenAsync awaits and captures rejections", async () => {
    await expect(andThenAsync(ok(2), async v => ok(v * 5))).resolves.toEqual({ ok: true, value: 10 });
    await expect(
      andThenAsync(ok(2), async () => {
        throw new Error("async fail");
      })
    ).resolves.toMatchObject({ ok: false });
    await expect(andThenAsync(err(new Error("e")), async () => ok(1))).resolves.toMatchObject({ ok: false });
  });

  it("collectAsync awaits every result", async () => {
    const result = await collectAsync([Promise.resolve(ok(1)), Promise.resolve(ok(2))]);
    expect(result).toEqual({ ok: true, value: [1, 2] });
  });
});