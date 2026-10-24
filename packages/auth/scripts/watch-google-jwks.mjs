#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_DISCOVERY_URL =
  "https://accounts.google.com/.well-known/openid-configuration";

const DISCOVERY_URL =
  process.env.GOOGLE_OIDC_DISCOVERY_URL?.trim() || DEFAULT_DISCOVERY_URL;

const INTERVAL_SECONDS = parsePositiveInteger(
  process.env.JWKS_WATCH_INTERVAL,
  300,
);

const MAX_POLLS = parseNonNegativeInteger(
  process.env.JWKS_WATCH_MAX_POLLS,
  0,
);

const OUTPUT_DIR = path.resolve(
  process.env.JWKS_WATCH_DIR ?? "./artifacts/google-jwks",
);

const TOKEN = process.env.OIDC_ID_TOKEN?.trim() || undefined;

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, fallback) {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, received: ${value}`);
  }
  return parsed;
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-");
}

function fingerprint(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function normalizeKeys(jwks) {
  if (!jwks || !Array.isArray(jwks.keys)) {
    throw new Error("JWKS response does not contain a keys array.");
  }

  return jwks.keys
    .map((key) => {
      const normalized = {
        kid: key.kid ?? null,
        kty: key.kty ?? null,
        alg: key.alg ?? null,
        use: key.use ?? null,
        n: key.n ?? null,
        e: key.e ?? null,
        crv: key.crv ?? null,
        x: key.x ?? null,
        y: key.y ?? null,
      };
      return {
        ...normalized,
        fingerprint: fingerprint(normalized),
      };
    })
    .sort((a, b) => String(a.kid).localeCompare(String(b.kid)));
}

function compareKeys(previousKeys, currentKeys) {
  const oldByKid = new Map(previousKeys.map((key) => [key.kid, key]));
  const newByKid = new Map(currentKeys.map((key) => [key.kid, key]));

  return {
    added: currentKeys.filter((key) => !oldByKid.has(key.kid)),
    removed: previousKeys.filter((key) => !newByKid.has(key.kid)),
    changed: currentKeys.filter((key) => {
      const previous = oldByKid.get(key.kid);
      return Boolean(previous && previous.fingerprint !== key.fingerprint);
    }),
  };
}

function pathsFor(outputDir) {
  return {
    outputDir,
    snapshotsDir: path.join(outputDir, "snapshots"),
    baselinePath: path.join(outputDir, "baseline.json"),
    latestPath: path.join(outputDir, "latest.json"),
    eventsPath: path.join(outputDir, "events.jsonl"),
    statusPath: path.join(outputDir, "status.json"),
  };
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
}

async function appendEvent(filePath, event) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, {
    mode: 0o600,
  });
}

async function fetchJson(url, timeoutMs = 20_000, headers = {}) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      ...headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  let body;
  if (response.status !== 304) {
    body = await response.json();
  }

  return {
    status: response.status,
    ok: response.ok,
    body,
    headers: {
      cacheControl: response.headers.get("cache-control"),
      etag: response.headers.get("etag"),
      date: response.headers.get("date"),
      retryAfter: response.headers.get("retry-after"),
    },
    url,
  };
}

function inspectTokenHeader(token) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("OIDC_ID_TOKEN is not a three-part JWT.");
  }

  let header;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw new Error("Could not parse the JWT header.");
  }

  if (!header || typeof header !== "object") {
    throw new Error("JWT header is not a JSON object.");
  }

  return {
    alg: header.alg ?? null,
    kid: header.kid ?? null,
    typ: header.typ ?? null,
  };
}

async function loadState(paths) {
  const baseline = await readJsonIfExists(paths.baselinePath);
  const latest = await readJsonIfExists(paths.latestPath);

  if (baseline && !Array.isArray(baseline.keys)) {
    throw new Error("Baseline file exists but is invalid.");
  }

  const latestValid =
    latest && Array.isArray(latest.keys) ? latest : undefined;

  const keys = latestValid?.keys ?? baseline?.keys ?? null;
  const etag = latestValid?.etag ?? null;

  return {
    baseline: baseline ?? null,
    baselineExists: Boolean(baseline),
    keys,
    etag,
    previousSource: latestValid ? "latest" : baseline ? "baseline" : "none",
    detectedAfterRestart: Boolean(baseline || latestValid),
  };
}

async function run() {
  const paths = pathsFor(OUTPUT_DIR);
  await fs.mkdir(paths.outputDir, { recursive: true });
  await fs.mkdir(paths.snapshotsDir, { recursive: true });

  console.log("Google OIDC JWKS live rotation observer");
  console.log(`Snapshots: ${paths.snapshotsDir}`);
  console.log(`State files: ${paths.outputDir}`);
  console.log(`Polling interval: ${INTERVAL_SECONDS}s`);
  console.log(`Maximum polls: ${MAX_POLLS === 0 ? "unlimited" : MAX_POLLS}`);
  console.log("Press Ctrl+C to stop.");

  let state = await loadState(paths);

  if (state.baselineExists) {
    console.log(
      `Loaded persisted baseline with ${state.baseline.keys.length} key(s).`,
    );
  } else {
    console.log("No persisted baseline found. The first successful poll will create one.");
  }

  if (state.keys) {
    console.log(
      `Loaded previous observation with ${state.keys.length} key(s) from ${state.previousSource}.`,
    );
  }

  let tokenHeader;
  if (TOKEN) {
    try {
      tokenHeader = inspectTokenHeader(TOKEN);
      console.log("\nSupplied token header:");
      console.log(`kid: ${tokenHeader.kid ?? "(missing)"}`);
      console.log(`alg: ${tokenHeader.alg ?? "(missing)"}`);
      console.log(
        "Warning: decoding a JWT header does not validate the token. Use npm run verify:google:id-token for full validation.",
      );
    } catch (error) {
      console.error(
        `OIDC_ID_TOKEN header inspection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      tokenHeader = null;
    }
  }

  let stopping = false;
  const shutdown = () => {
    stopping = true;
    console.log("\nShutdown requested; finishing current work.");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  let consecutiveFailures = 0;
  let pollCount = 0;

  while (!stopping && (MAX_POLLS === 0 || pollCount < MAX_POLLS)) {
    pollCount += 1;
    const observedAt = new Date().toISOString();

    const context = {
      paths,
      previousState: state,
      tokenHeader,
    };

    try {
      const discovery = await fetchJson(DISCOVERY_URL, 20_000);
      if (!discovery.ok) {
        throw new Error(`Discovery endpoint returned HTTP ${discovery.status}`);
      }

      const metadata = discovery.body;
      const issuer = metadata?.issuer;
      if (
        issuer !== "https://accounts.google.com" &&
        issuer !== "accounts.google.com"
      ) {
        throw new Error(`Unexpected Google OIDC issuer: ${String(issuer)}`);
      }

      const jwksUrl = metadata?.jwks_uri;
      if (typeof jwksUrl !== "string" || !jwksUrl.startsWith("https://")) {
        throw new Error("Discovery document contains no valid HTTPS jwks_uri.");
      }

      const requestHeaders = {};
      if (state.etag) {
        requestHeaders["if-none-match"] = state.etag;
      }

      const jwksResponse = await fetchJson(jwksUrl, 20_000, requestHeaders);

      if (jwksResponse.status === 304) {
        state = {
          ...state,
          consecutiveFailures: 0,
        };
        await atomicWriteJson(paths.statusPath, {
          updatedAt: observedAt,
          result: "not_modified",
          jwksUrl,
          issuer,
          keyCount: state.keys?.length ?? 0,
          jwksEtag: state.etag,
          consecutiveFailures: 0,
        });
        console.log(
          `[${observedAt}] Google JWKS unchanged (HTTP 304); ${state.keys?.length ?? 0} key(s)`,
        );
      } else {
        if (!jwksResponse.ok) {
          throw new Error(`JWKS endpoint returned HTTP ${jwksResponse.status}`);
        }

        const keys = normalizeKeys(jwksResponse.body);
        const previousKeys = state.keys ?? null;
        const changes =
          previousKeys === null ? null : compareKeys(previousKeys, keys);

        const snapshot = {
          observedAt,
          issuer,
          jwksUrl,
          discoveryStatus: discovery.status,
          jwksStatus: jwksResponse.status,
          discoveryCacheControl: discovery.headers.cacheControl,
          jwksCacheControl: jwksResponse.headers.cacheControl,
          discoveryEtag: discovery.headers.etag,
          jwksEtag: jwksResponse.headers.etag,
          discoveryDate: discovery.headers.date,
          jwksDate: jwksResponse.headers.date,
          keys,
        };

        const snapshotName = `${timestamp()}.json`;
        const snapshotPath = path.join(paths.snapshotsDir, snapshotName);
        await atomicWriteJson(snapshotPath, snapshot);

        if (!state.baselineExists) {
          await atomicWriteJson(paths.baselinePath, {
            recordedAt: observedAt,
            issuer,
            jwksUrl,
            keys,
          });
        }

        if (
          changes?.added?.length ||
          changes?.removed?.length ||
          changes?.changed?.length
        ) {
          const securityWarning = changes.changed.length
            ? "A previously observed kid changed its public key material; treat this as a security event."
            : undefined;

          await appendEvent(paths.eventsPath, {
            observedAt,
            type: "KEY_SET_CHANGED",
            added: changes.added.map((key) => key.kid),
            removed: changes.removed.map((key) => key.kid),
            changed: changes.changed.map((key) => key.kid),
            previousKeyCount: previousKeys.length,
            currentKeyCount: keys.length,
            snapshot: snapshotName,
            detectedAfterRestart: state.detectedAfterRestart,
            securityWarning,
          });

          console.log(
            "\nJWKS CHANGE OBSERVED - this alone does not prove a Google signing-key rotation.",
          );
          if (changes.added.length) {
            console.log(`Added kid(s): ${changes.added.map((key) => key.kid).join(", ")}`);
          }
          if (changes.removed.length) {
            console.log(`Removed kid(s): ${changes.removed.map((key) => key.kid).join(", ")}`);
          }
          if (changes.changed.length) {
            console.log(`Changed public material for kid(s): ${changes.changed.map((key) => key.kid).join(", ")}`);
            console.log(securityWarning);
          }
        } else if (previousKeys !== null) {
          console.log(`[${observedAt}] No key-set changes observed.`);
        } else {
          await appendEvent(paths.eventsPath, {
            observedAt,
            type: "BASELINE_RECORDED",
            keyCount: keys.length,
            keyIds: keys.map((key) => key.kid),
            snapshot: snapshotName,
          });
          console.log("Initial baseline saved. Waiting for changes.");
        }

        console.log(`\n[${observedAt}] Google published ${keys.length} key(s)`);
        console.log(`JWKS: ${jwksUrl}`);
        console.log(`Cache-Control: ${jwksResponse.headers.cacheControl ?? "(not supplied)"}`);
        for (const key of keys) {
          console.log(
            `  kid=${key.kid ?? "(missing)"} alg=${key.alg ?? "(unspecified)"} kty=${key.kty ?? "(unspecified)"} sha256=${key.fingerprint}`,
          );
        }

        if (tokenHeader?.kid) {
          const found = keys.some((key) => key.kid === tokenHeader.kid);
          console.log(
            `Supplied token kid ${tokenHeader.kid}: ${
              found ? "present in current Google JWKS" : "NOT present in current Google JWKS"
            }`,
          );
          if (!state.baseline?.keys?.some((key) => key.kid === tokenHeader.kid)) {
            console.log("Supplied token kid is absent from the persisted baseline and may be a live rotation candidate.");
          }
        }

        const latest = {
          observedAt,
          issuer,
          jwksUrl,
          etag: jwksResponse.headers.etag ?? state.etag ?? null,
          cacheControl: jwksResponse.headers.cacheControl,
          keyCount: keys.length,
          keys,
        };

        await atomicWriteJson(paths.latestPath, latest);

        state = {
          baseline: state.baselineExists
            ? state.baseline
            : {
                recordedAt: observedAt,
                issuer,
                jwksUrl,
                keys,
              },
          baselineExists: true,
          keys,
          etag: latest.etag,
          previousSource: "latest",
          detectedAfterRestart: false,
        };

        await atomicWriteJson(paths.statusPath, {
          updatedAt: observedAt,
          result: "observed",
          discoveryStatus: discovery.status,
          jwksStatus: jwksResponse.status,
          keyCount: keys.length,
          jwksUrl,
          issuer,
          jwksEtag: latest.etag,
          consecutiveFailures: 0,
          changesObserved: Boolean(
            changes?.added?.length ||
              changes?.removed?.length ||
              changes?.changed?.length,
          ),
        });
      }

      state = {
        ...state,
        consecutiveFailures: 0,
      };
      consecutiveFailures = 0;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      const status =
        error && typeof error.status === "number" ? error.status : undefined;

      consecutiveFailures += 1;
      const backoffSeconds = Math.min(
        INTERVAL_SECONDS * 2 ** Math.min(consecutiveFailures, 6),
        3600,
      );

      console.error(
        `\n[${observedAt}] Observation failed${status ? ` (HTTP ${status})` : ""}: ${message}`,
      );

      try {
        await atomicWriteJson(paths.statusPath, {
          updatedAt: observedAt,
          result: "error",
          error: message,
          httpStatus: status,
          consecutiveFailures,
          nextPollSeconds: backoffSeconds,
        });
      } catch (statusError) {
        console.error(
          `Could not write status file: ${statusError instanceof Error ? statusError.message : String(statusError)}`,
        );
      }

      if (!stopping && (MAX_POLLS === 0 || pollCount < MAX_POLLS)) {
        console.log(`Backing off for ${backoffSeconds}s.`);
        await sleep(backoffSeconds * 1000);
      }
      continue;
    }

    if (!stopping && (MAX_POLLS === 0 || pollCount < MAX_POLLS)) {
      await sleep(INTERVAL_SECONDS * 1000);
    }
  }

  if (stopping) {
    try {
      await atomicWriteJson(paths.statusPath, {
        updatedAt: new Date().toISOString(),
        result: "stopped",
        keyCount: state.keys?.length ?? 0,
        jwksUrl: state.baseline?.jwksUrl,
      });
    } catch {
      // Best effort only.
    }
    console.log("Google JWKS observer stopped.");
  }
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname);

if (isMainModule) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  normalizeKeys,
  compareKeys,
  fingerprint,
  pathsFor,
  readJsonIfExists,
  atomicWriteJson,
  appendEvent,
  fetchJson,
  parsePositiveInteger,
  parseNonNegativeInteger,
  inspectTokenHeader,
  loadState,
};
