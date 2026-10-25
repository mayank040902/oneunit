import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, "..", "..", "examples");

const RUNNING_REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
// Nothing listens here, so every example takes its early-exit path.
const UNREACHABLE_REDIS_URL = "redis://127.0.0.1:6399";

const EXAMPLE_NAMES = [
  "efficient",
];

interface RunOptions {
  url: string;
  timeoutMs?: number;
  inject?: { file: string; after: string; code: string };
}

/** Run an example, optionally with a bug injected at a specific line. */
function runExample(name: string, options: RunOptions) {
  const { url, timeoutMs = 30_000, inject } = options;
  const file = join(EXAMPLES, `${name}.js`);

  if (!inject) {
    return spawnSync(process.execPath, [file], {
      encoding: "utf8",
      timeout: timeoutMs,
      env: {
        ...process.env,
        REDIS_URL: url,
        REDIS_SILENT: "true",
      },
    });
  }

  // Run a copy with the bug injected, so the checked-in example is untouched.
  const original = readFileSync(join(EXAMPLES, inject.file), "utf8");
  const injected = original.replace(
    inject.after,
    `${inject.after}\n${inject.code}`,
  );

  assert.notEqual(injected, original, "injection anchor not found");

  const tmp = join(EXAMPLES, `.injected-${name}.mjs`);
  writeFileSync(tmp, injected);

  try {
    return spawnSync(process.execPath, [tmp], {
      encoding: "utf8",
      timeout: timeoutMs,
      cwd: EXAMPLES,
      env: {
        ...process.env,
        REDIS_URL: url,
        REDIS_SILENT: "true",
      },
    });
  } finally {
    rmSync(tmp, { force: true });
  }
}

for (const url of [RUNNING_REDIS_URL, UNREACHABLE_REDIS_URL]) {
  const reachable = url === RUNNING_REDIS_URL;

  for (const name of EXAMPLE_NAMES) {
    test(`${name} exits 0 against ${reachable ? "a running" : "an unreachable"} Redis`, () => {
      const result = runExample(name, { url });

      assert.equal(
        result.status,
        0,
        `${name} exited ${result.status} (${result.signal ?? "no signal"}) against ${url}\n${result.stderr}`,
      );
    });
  }
}


