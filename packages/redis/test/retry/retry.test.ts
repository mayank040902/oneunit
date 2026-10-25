import { test } from "vitest";
import assert from "node:assert/strict";
import {
  retryOperation,
  retryOperationWithResult,
} from "../../dist/features/retry.js";

test("retryOperation succeeds after transient failures", async () => {
  let calls = 0;
  const value = await retryOperation(async () => {
    calls += 1;
    if (calls < 3) throw new Error("temporary outage");
    return "ok";
  }, { attempts: 3, baseDelayMs: 1, jitter: false });

  assert.equal(value, "ok");
  assert.equal(calls, 3);
});

test("retryOperationWithResult reports attempts", async () => {
  const result = await retryOperationWithResult(async () => "done", { attempts: 1, baseDelayMs: 1, jitter: false });
  assert.equal(result.value, "done");
  assert.equal(result.attempts, 1);
});

test("retryOperation does not retry when retryWhen returns false", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retryOperation(
        async () => {
          calls += 1;
          throw new Error("permanent");
        },
        {
          attempts: 3,
          baseDelayMs: 1,
          jitter: false,
          retryWhen: () => false,
        },
      ),
    /permanent/,
  );

  assert.equal(calls, 1);
});

test("retryOperation validates its policy", async () => {
  await assert.rejects(
    () => retryOperation(() => Promise.resolve("ok"), { attempts: 0 }),
    /positive finite/,
  );
});

test("retryOperation stress test", async () => {
  for (let i = 0; i < 1000; i++) {
    const value = await retryOperation(async () => "ok", { attempts: 1, baseDelayMs: 0, jitter: false });
    assert.equal(value, "ok");
  }
});

test("retryOperation calls onRetry with attempt and delay", async () => {
  const retries = [];
  await assert.rejects(
    () =>
      retryOperation(
        async () => {
          throw new Error("temporary");
        },
        {
          attempts: 2,
          baseDelayMs: 4,
          maxDelayMs: 10,
          jitter: false,
          onRetry: (attempt, error, delayMs) =>
            retries.push({ attempt, message: (error as Error).message, delayMs }),
        },
      ),
    /temporary/,
  );

  assert.equal(retries.length, 1);
  assert.equal(retries[0].attempt, 1);
  assert.equal(retries[0].message, "temporary");
  assert.equal(retries[0].delayMs, 4);
});

test("retryOperation respects maxDelayMs", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retryOperation(
        async () => {
          calls += 1;
          throw new Error("temporary");
        },
        {
          attempts: 4,
          baseDelayMs: 1000,
          maxDelayMs: 10,
          jitter: false,
        },
      ),
    /temporary/,
  );

  assert.equal(calls, 4);
});

test("retryOperation with jitter still completes fast enough", async () => {
  const start = Date.now();
  const value = await retryOperation(async () => "ok", {
    attempts: 1,
    baseDelayMs: 0,
    jitter: true,
  });
  assert.equal(value, "ok");
  assert.ok(Date.now() - start < 1000);
});

test("retryOperation async stress with eventual success", async () => {
  for (let i = 0; i < 100; i++) {
    let calls = 0;
    const value = await retryOperation(async () => {
      calls += 1;
      if (calls <= 2) throw new Error("temporary");
      return i;
    }, { attempts: 3, baseDelayMs: 1, jitter: false });
    assert.equal(value, i);
  }
});
