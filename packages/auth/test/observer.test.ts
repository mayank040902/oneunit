import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const observer = await import("../scripts/watch-google-jwks.mjs");

describe("Google JWKS observer utilities", () => {
  it("normalizes keys and computes a stable fingerprint", () => {
    const first = observer.normalizeKeys({
      keys: [{ kid: "b", kty: "RSA", alg: "RS256", n: "abc", e: "AQAB" }],
    });
    const second = observer.normalizeKeys({
      keys: [{ kid: "b", kty: "RSA", alg: "RS256", n: "abc", e: "AQAB" }],
    });

    assert.equal(first.length, 1);
    assert.equal(first[0].kid, "b");
    assert.equal(first[0].fingerprint, second[0].fingerprint);
  });

  it("detects added, removed, and changed kids", () => {
    const oldKeys = [
      { kid: "a", fingerprint: "1" },
      { kid: "b", fingerprint: "2" },
    ];
    const newKeys = [
      { kid: "b", fingerprint: "changed" },
      { kid: "c", fingerprint: "3" },
    ];

    const changes = observer.compareKeys(oldKeys, newKeys);

    assert.deepEqual(changes.added.map((key: { kid: string }) => key.kid), ["c"]);
    assert.deepEqual(changes.removed.map((key: { kid: string }) => key.kid), ["a"]);
    assert.deepEqual(changes.changed.map((key: { kid: string }) => key.kid), ["b"]);
  });

  it("decodes a JWT header without validating the token", () => {
    const header = Buffer.from(
      JSON.stringify({ kid: "test-kid", alg: "RS256", typ: "JWT" }),
    ).toString("base64url");
    const token = `${header}.payload.signature`;

    assert.deepEqual(observer.inspectTokenHeader(token), {
      kid: "test-kid",
      alg: "RS256",
      typ: "JWT",
    });
  });

  it("validates positive integer parsing", () => {
    assert.equal(observer.parsePositiveInteger("300", 60), 300);
    assert.throws(() => observer.parsePositiveInteger("0", 60));
    assert.throws(() => observer.parsePositiveInteger("abc", 60));
  });

  it("round-trips state using atomic writes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "observer-state-"));
    const paths = observer.pathsFor(tempDir);

    await observer.atomicWriteJson(paths.statusPath, { result: "ok", count: 1 });
    const loaded = await observer.readJsonIfExists(paths.statusPath);

    assert.deepEqual(loaded, { result: "ok", count: 1 });
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
