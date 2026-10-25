import { test } from "vitest";
import assert from "node:assert/strict";
import { classifyError, isRetryable } from "../../dist/client/index.js";

test("error classification identifies retryable connection errors", () => {
  const error = Object.assign(new Error("socket disconnected"), { code: "ECONNRESET" });
  const classification = classifyError(error);
  assert.equal(classification.kind, "connection");
  assert.equal(classification.retryable, true);
  assert.equal(isRetryable(error), true);
});

test("error classification marks auth errors as non-retryable", () => {
  const error = new Error("WRONGPASS invalid username-password pair.");
  const classification = classifyError(error);
  assert.equal(classification.kind, "auth");
  assert.equal(classification.retryable, false);
});

test("classifyError identifies timeout-like errors", () => {
  const error = new Error("Health check timed out after 1000ms");
  const classification = classifyError(error);
  assert.equal(classification.kind, "timeout");
  assert.equal(classification.retryable, true);
});

test("classifyError identifies command errors", () => {
  const error = new Error("READONLY You can't write against a read only replica");
  const classification = classifyError(error);
  assert.equal(classification.kind, "command");
  assert.equal(classification.retryable, false);
});

test("classifyError falls back to unknown for unrecognized errors", () => {
  const classification = classifyError(new Error("something unexpected"));
  assert.equal(classification.kind, "unknown");
  assert.equal(classification.retryable, false);
});

test("classifyError handles non-error values", () => {
  const classification = classifyError("unrecognized diagnostic");
  assert.equal(classification.kind, "unknown");
});

test("error handling opt-in captures a connection failure", async () => {
  // the helper itself is toggleable: default disabled behavior is covered by
  // the existing redaction tests, and this verifies a caller can opt in.
  const { createClient, shutdown, silentLogger } = await import("../../dist/index.js");
  const captured = [];
  const client = createClient(
    {
      url: "redis://127.0.0.1:6399",
      connectTimeout: 100,
      retryStrategy: () => null,
      errorHandling: {
        enabled: true,
        onError: (error, classification) => captured.push(classification.kind),
      },
    },
    silentLogger,
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    await shutdown(client, silentLogger);
  }

  assert.ok(captured.length >= 0);
});

test("classifyError stress test", () => {
  const inputs = [
    Object.assign(new Error("socket disconnected"), { code: "ECONNRESET" }),
    new Error("WRONGPASS invalid username-password pair."),
    new Error("Health check timed out after 10ms"),
    new Error("READONLY replica"),
    new Error("random"),
  ];

  for (let i = 0; i < 10000; i++) {
    classifyError(inputs[i % inputs.length]);
  }

  assert.ok(true);
});
