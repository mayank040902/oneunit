import { describe, it, expect, vi } from "vitest";
import {
  tryCatch,
  tryCatchAsync,
  toAppError,
  tryCatchSync,
  tryCatchPromise,
  ok,
  err,
  isOk,
  isErr,
  unwrap,
  unwrapOr,
  map,
  mapErr,
  andThen,
  orElse,
  tryCatchResult,
  combine,
  tryAll,
  withTimeout,
  withRetry,
  AppError,
  InternalError,
  ValidationError,
} from "../src/index.js";

describe("tryCatch", () => {
  it("returns data on success", () => {
    const result = tryCatch(() => 42);
    expect(result.data).toBe(42);
    expect(result.error).toBeNull();
  });

  it("returns error on throw", () => {
    const result = tryCatch(() => { throw new Error("fail"); });
    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(AppError);
    expect(result.error?.message).toBe("fail");
  });

  it("uses custom errorFactory", () => {
    const result = tryCatch(
      () => { throw new Error("fail"); },
      (e) => new ValidationError("Custom", { field: [String(e)] })
    );
    expect(result.error).toBeInstanceOf(ValidationError);
    expect(result.error?.code).toBe("VALIDATION_ERROR");
  });
});

describe("tryCatchAsync", () => {
  it("resolves with data on success", async () => {
    const result = await tryCatchAsync(Promise.resolve("success"));
    expect(result.data).toBe("success");
    expect(result.error).toBeNull();
  });

  it("resolves with error on rejection", async () => {
    const result = await tryCatchAsync(Promise.reject(new Error("async fail")));
    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(AppError);
    expect(result.error?.message).toBe("async fail");
  });
});

describe("toAppError", () => {
  it("returns AppError as-is", () => {
    const original = new InternalError("test");
    expect(toAppError(original)).toBe(original);
  });

  it("wraps Error", () => {
    const error = toAppError(new Error("plain"));
    expect(error).toBeInstanceOf(InternalError);
    expect(error.message).toBe("plain");
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("wraps unknown values", () => {
    const error = toAppError("string error");
    expect(error).toBeInstanceOf(InternalError);
    expect(error.message).toBe("string error");
  });
});

describe("Result type", () => {
  it("ok creates success result", () => {
    const result = ok(42);
    expect(isOk(result)).toBe(true);
    expect(result.value).toBe(42);
  });

  it("err creates error result", () => {
    const error = new ValidationError("test", {});
    const result = err(error);
    expect(isErr(result)).toBe(true);
    expect(result.error).toBe(error);
  });

  it("unwrap returns value on ok", () => {
    expect(unwrap(ok(10))).toBe(10);
  });

  it("unwrap throws on err", () => {
    expect(() => unwrap(err(new Error("fail")))).toThrow();
  });

  it("unwrapOr returns fallback on err", () => {
    expect(unwrapOr(err(new Error("fail")), 0)).toBe(0);
    expect(unwrapOr(ok(5), 0)).toBe(5);
  });

  it("map transforms ok value", () => {
    const result = map(ok(2), x => x * 3);
    expect(isOk(result)).toBe(true);
    expect(result.value).toBe(6);
  });

  it("map passes through err", () => {
    const error = new ValidationError("test", {});
    const result = map(err(error), x => x * 3);
    expect(isErr(result)).toBe(true);
    expect(result.error).toBe(error);
  });

  it("mapErr transforms error", () => {
    const result = mapErr(err(new ValidationError("test", {})), e => new InternalError(e.message));
    expect(isErr(result)).toBe(true);
    expect(result.error).toBeInstanceOf(InternalError);
  });

  it("andThen chains ok results", () => {
    const result = andThen(ok(2), x => ok(x * 5));
    expect(isOk(result)).toBe(true);
    expect(result.value).toBe(10);
  });

  it("andThen passes through err", () => {
    const error = new ValidationError("test", {});
    const result = andThen(err(error), x => ok(x * 5));
    expect(isErr(result)).toBe(true);
    expect(result.error).toBe(error);
  });

  it("orElse recovers from err", () => {
    const result = orElse(err(new ValidationError("test", {})), () => ok(42));
    expect(isOk(result)).toBe(true);
    expect(result.value).toBe(42);
  });

  it("orElse passes through ok", () => {
    const result = orElse(ok(10), () => ok(42));
    expect(isOk(result)).toBe(true);
    expect(result.value).toBe(10);
  });
});

describe("tryCatchResult", () => {
  it("returns ok on success", async () => {
    const result = await tryCatchResult(Promise.resolve("data"));
    expect(isOk(result)).toBe(true);
    expect(result.value).toBe("data");
  });

  it("returns err on failure", async () => {
    const result = await tryCatchResult(Promise.reject(new Error("fail")));
    expect(isErr(result)).toBe(true);
    expect(result.error).toBeInstanceOf(AppError);
  });
});

describe("combine", () => {
  it("combines multiple ok results", () => {
    const result = combine([ok(1), ok(2), ok(3)] as const);
    expect(isOk(result)).toBe(true);
    expect(result.value).toEqual([1, 2, 3]);
  });

  it("returns first err", () => {
    const error = new ValidationError("test", {});
    const result = combine([ok(1), err(error), ok(3)] as const);
    expect(isErr(result)).toBe(true);
    expect(result.error).toBe(error);
  });
});

describe("tryAll", () => {
  it("resolves all promises", async () => {
    const result = await tryAll([
      Promise.resolve(1),
      Promise.resolve(2),
    ]);
    expect(isOk(result)).toBe(true);
    expect(result.value).toEqual([1, 2]);
  });

  it("returns first rejection", async () => {
    const result = await tryAll([
      Promise.resolve(1),
      Promise.reject(new Error("fail")),
    ]);
    expect(isErr(result)).toBe(true);
    expect(result.error).toBeInstanceOf(AppError);
  });
});

describe("withTimeout", () => {
  it("resolves if promise completes in time", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 100);
    expect(result).toBe("ok");
  });

  it("rejects with TimeoutError if promise takes too long", async () => {
    await expect(withTimeout(new Promise(r => setTimeout(r, 200)), 50)).rejects.toThrow("Operation timed out");
  });

  it("clears the timer when the promise settles first", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    await withTimeout(Promise.resolve("ok"), 5000);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});

describe("withRetry", () => {
  it("succeeds on first attempt", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      return "success";
    });
    expect(result).toBe("success");
    expect(attempts).toBe(1);
  });

  it("retries on failure", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("fail");
        return "success";
      },
      { maxAttempts: 5, delay: 10 }
    );
    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  it("fails after max attempts", async () => {
    let attempts = 0;
    await expect(withRetry(
      async () => {
        attempts++;
        throw new Error("fail");
      },
      { maxAttempts: 3, delay: 10 }
    )).rejects.toThrow("fail");
    expect(attempts).toBe(3);
  });

  it("uses shouldRetry predicate", async () => {
    let attempts = 0;
    await expect(withRetry(
      async () => {
        attempts++;
        throw new ValidationError("validation fail", {});
      },
      { maxAttempts: 5, delay: 10, shouldRetry: e => !(e instanceof ValidationError) }
    )).rejects.toThrow("validation fail");
    expect(attempts).toBe(1);
  });

  it("rejects instead of hanging when shouldRetry throws", async () => {
    let attempts = 0;
    await expect(withRetry(
      async () => {
        attempts++;
        throw new Error("boom");
      },
      {
        maxAttempts: 3,
        delay: 1,
        shouldRetry: () => { throw new Error("predicate exploded"); },
      }
    )).rejects.toThrow("predicate exploded");
    expect(attempts).toBe(1);
  });

  it("runs at least one attempt when maxAttempts is below one", async () => {
    let attempts = 0;
    const result = await withRetry(async () => { attempts++; return "ok"; }, { maxAttempts: 0 });
    expect(result).toBe("ok");
    expect(attempts).toBe(1);
  });

  it("never rejects with undefined for non-finite options", async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => { attempts++; throw new Error("fail"); }, { maxAttempts: Number.NaN, delay: 1 })
    ).rejects.toThrow("fail");
    expect(attempts).toBe(1);

    await expect(
      withRetry(async () => { throw new Error("fail"); }, { maxAttempts: 3, delay: Number.NaN, backoff: Number.NaN })
    ).rejects.toThrow("fail");
  });
});

describe("errorFactory failures", () => {
  it("tryCatch falls back to AppError when errorFactory throws", () => {
    const result = tryCatch(
      () => { throw new Error("fail"); },
      () => { throw new Error("factory exploded"); }
    );
    expect(result.error).toBeInstanceOf(AppError);
    expect(result.error?.message).toBe("fail");
  });

  it("tryCatchAsync falls back to AppError when errorFactory throws", async () => {
    const result = await tryCatchAsync(
      Promise.reject(new Error("fail")),
      () => { throw new Error("factory exploded"); }
    );
    expect(result.error).toBeInstanceOf(AppError);
    expect(result.error?.message).toBe("fail");
  });

  it("tryAll returns err when errorFactory throws", async () => {
    const result = await tryAll(
      [Promise.reject(new Error("fail"))],
      () => { throw new Error("factory exploded"); }
    );
    expect(isErr(result)).toBe(true);
    expect(result.error).toBeInstanceOf(AppError);
  });
});

describe("tryCatchSync", () => {
  it("returns value on success", () => {
    const result = tryCatchSync(() => 42);
    expect(result).toBe(42);
  });

  it("returns null and calls onError on failure", () => {
    let capturedError: AppError | null = null;
    const result = tryCatchSync(
      () => { throw new Error("fail"); },
      { onError: e => capturedError = e }
    );
    expect(result).toBeNull();
    expect(capturedError).toBeInstanceOf(AppError);
  });
});

describe("tryCatchPromise", () => {
  it("returns value on success", async () => {
    const result = await tryCatchPromise(Promise.resolve("ok"));
    expect(result).toBe("ok");
  });

  it("returns null and calls onError on failure", async () => {
    let capturedError: AppError | null = null;
    const result = await tryCatchPromise(
      Promise.reject(new Error("fail")),
      { onError: e => capturedError = e }
    );
    expect(result).toBeNull();
    expect(capturedError).toBeInstanceOf(AppError);
  });
});