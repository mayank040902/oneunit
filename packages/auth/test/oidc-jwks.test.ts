import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { KeyObject } from "node:crypto";
import {
  createServer,
} from "node:http";
import { generateKeyPairSync, sign as signRSA } from "node:crypto";
import {
  createOAuth,
  ProviderError,
  type OAuthProviderConfig,
} from "../src/index.js";

/**
 * Local OIDC / JWKS test server for deterministic key-rotation testing.
 *
 * The package does not implement OIDC discovery (`/.well-known/openid-configuration`)
 * nor automatic JWKS URL derivation from issuer metadata. JWKS URLs are configured
 * per provider through `OAuthProviderConfig.jwksUrl` or the `jwks` inline option.
 * This test server exercises the package's actual JWKS fetch + kid cache + refetch
 * behaviour against a controllable local endpoint instead of a live third-party
 * provider.
 *
 * The built-in `apple` provider checks `iss === "https://appleid.apple.com"`, so
 * test tokens use Apple's real issuer string while pointing `jwksUrl` at the local
 * test server. This verifies the full JWKS fetch + signature verification path
 * without touching Apple's network.
 */
interface JwkEntry {
  publicKey: KeyObject;
  privateKey: KeyObject;
  kid: string;
}

const APPLE_ISSUER = "https://appleid.apple.com";

function buildJwks(keys: JwkEntry[]): { keys: Record<string, unknown>[] } {
  return {
    keys: keys.map(({ publicKey, kid }) => {
      const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
      return { ...jwk, kid, alg: "RS256", use: "sig" };
    }),
  };
}

function signIdToken(
  claims: Record<string, unknown>,
  privateKey: KeyObject,
  options: { kid?: string; alg?: string } = {},
): string {
  const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const header: Record<string, unknown> = { alg: options.alg ?? "RS256" };
  if (options.kid !== undefined) header.kid = options.kid;
  const head = b64(header);
  const body = b64(claims);
  const signature = signRSA("RSA-SHA256", Buffer.from(`${head}.${body}`, "utf8"), privateKey);
  return `${head}.${body}.${signature.toString("base64url")}`;
}

function createOidcTestServer() {
  let currentKeys: JwkEntry[] = [];
  let fetchCount = 0;
  let failNextFetch = false;
  let malformedNextFetch = false;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${(server.address() as { port: number }).port}`);
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");

    if (url.pathname === "/.well-known/openid-configuration") {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          issuer: APPLE_ISSUER,
          authorization_endpoint: "http://localhost:19999/auth",
          token_endpoint: "http://localhost:19999/token",
          jwks_uri: `http://localhost:${(server.address() as { port: number }).port}/.well-known/jwks.json`,
        }),
      );
      return;
    }

    if (url.pathname === "/.well-known/jwks.json") {
      fetchCount += 1;
      if (failNextFetch) {
        failNextFetch = false;
        res.writeHead(503);
        res.end(JSON.stringify({ error: "temporary outage" }));
        return;
      }
      if (malformedNextFetch) {
        malformedNextFetch = false;
        res.writeHead(200);
        res.end("{ not valid json");
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify(buildJwks(currentKeys)));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });

  return {
    server,
    start(): Promise<number> {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          resolve((server.address() as { port: number }).port);
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    setKeys(keys: JwkEntry[]) {
      currentKeys = keys;
    },
    addKey(key: JwkEntry) {
      currentKeys = [...currentKeys, key];
    },
    removeKey(kid: string) {
      currentKeys = currentKeys.filter((k) => k.kid !== kid);
    },
    get fetchCount() {
      return fetchCount;
    },
    setFailNextFetch() {
      failNextFetch = true;
    },
    setMalformedNextFetch() {
      malformedNextFetch = true;
    },
    baseUrl() {
      return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    },
  };
}

const now = () => Math.floor(Date.now() / 1000);

function validClaims(over: Record<string, unknown> = {}) {
  return {
    iss: APPLE_ISSUER,
    aud: "test-client-id",
    sub: "u1",
    exp: now() + 3600,
    ...over,
  };
}

function keyPair() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

async function fetchProfileWithConfig(
  config: OAuthProviderConfig,
  idToken: string,
): Promise<{ id?: string }> {
  const oauth = createOAuth({ providers: { apple: config } });
  const entry = oauth.get("apple");
  const profile = await entry.provider.fetchProfile(entry.config, { id_token: idToken });
  return profile as { id?: string };
}

async function withOidcServer(fn: (server: ReturnType<typeof createOidcTestServer>) => Promise<void>) {
  const server = createOidcTestServer();
  await server.start();
  try {
    await fn(server);
  } finally {
    await server.stop();
  }
}

describe("local OIDC / JWKS integration (deterministic)", () => {
  describe("key setup and JWKS retrieval", () => {
    it("serves the configured JWKS and discovery metadata", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const res = await fetch(`${server.baseUrl()}/.well-known/jwks.json`);
        assert.equal(res.status, 200);
        const jwks = (await res.json()) as { keys: Record<string, unknown>[] };
        assert.equal(jwks.keys.length, 1);
        assert.equal(jwks.keys[0].kid, "key-a");

        const meta = await fetch(`${server.baseUrl()}/.well-known/openid-configuration`);
        assert.equal(meta.status, 200);
        const metadata = (await meta.json()) as { jwks_uri: string };
        assert.ok(metadata.jwks_uri.includes("/.well-known/jwks.json"));
      });
    });
  });

  describe("id_token verification against local JWKS", () => {
    it("accepts a correctly signed id_token", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
        };
        const token = signIdToken(validClaims(), privateKey, { kid: "key-a" });
        const profile = await fetchProfileWithConfig(config, token);
        assert.equal(profile.id, "u1");
      });
    });

    it("rejects a token signed by an unknown kid", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
        };
        const token = signIdToken(validClaims(), privateKey, { kid: "nonexistent" });
        await assert.rejects(() => fetchProfileWithConfig(config, token), ProviderError);
      });
    });

    it("rejects a token signed by a different key not in the JWKS", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        const other = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
        };
        const token = signIdToken(validClaims(), other.privateKey, { kid: "key-b" });
        await assert.rejects(() => fetchProfileWithConfig(config, token), ProviderError);
      });
    });

    it("rejects alg: none", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
        };
        const b64 = (value: unknown) =>
          Buffer.from(JSON.stringify(value)).toString("base64url");
        const unsigned = `${b64({ alg: "none", kid: "key-a" })}.${b64(validClaims())}.`;
        await assert.rejects(() => fetchProfileWithConfig(config, unsigned), ProviderError);
      });
    });

    it("rejects a token missing a kid", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
        };
        const token = signIdToken(validClaims(), privateKey, { kid: undefined });
        await assert.rejects(() => fetchProfileWithConfig(config, token), ProviderError);
      });
    });

    it("rejects a wrong issuer", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
        };
        const token = signIdToken(validClaims({ iss: "https://evil.example" }), privateKey, {
          kid: "key-a",
        });
        await assert.rejects(() => fetchProfileWithConfig(config, token), ProviderError);
      });
    });

    it("rejects an audience issued to another app", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
        };
        const token = signIdToken(validClaims({ aud: "com.other.app" }), privateKey, {
          kid: "key-a",
        });
        await assert.rejects(() => fetchProfileWithConfig(config, token), ProviderError);
      });
    });

    it("rejects an expired id_token", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
        };
        const token = signIdToken(validClaims({ exp: now() - 60 }), privateKey, {
          kid: "key-a",
        });
        await assert.rejects(() => fetchProfileWithConfig(config, token), ProviderError);
      });
    });

    it("rejects a malformed id_token", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
        };
        await assert.rejects(() => fetchProfileWithConfig(config, "not-a-jwt"), ProviderError);
      });
    });

    it("rejects an id_token with no exp", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
        };
        const { exp: _exp, ...noExp } = validClaims();
        const token = signIdToken(noExp, privateKey, { kid: "key-a" });
        await assert.rejects(() => fetchProfileWithConfig(config, token), ProviderError);
      });
    });

    it("accepts an audience array containing the clientId", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
        };
        const token = signIdToken(
          validClaims({ aud: ["x", "test-client-id"], sub: "u2" }),
          privateKey,
          { kid: "key-a" },
        );
        const profile = await fetchProfileWithConfig(config, token);
        assert.equal(profile.id, "u2");
      });
    });
  });

  describe("signing-key rotation", () => {
    it("accepts tokens signed with the initially trusted key", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
          jwksCacheTtlMs: 1_000,
        };
        const token = signIdToken(validClaims(), privateKey, { kid: "key-a" });
        const profile = await fetchProfileWithConfig(config, token);
        assert.equal(profile.id, "u1");
      });
    });

    it("accepts a new key after rotation once the cache expires", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
          jwksCacheTtlMs: 50,
        };

        const tokenA = signIdToken(validClaims({ sub: "u1" }), privateKey, { kid: "key-a" });
        let profile = await fetchProfileWithConfig(config, tokenA);
        assert.equal(profile.id, "u1");

        // Rotate: replace key-a with key-b.
        const pairB = keyPair();
        server.removeKey("key-a");
        server.addKey({ publicKey: pairB.publicKey, privateKey: pairB.privateKey, kid: "key-b" });

        // Wait for cache to expire.
        await new Promise((resolve) => setTimeout(resolve, 100));

        const tokenB = signIdToken(validClaims({ sub: "u2" }), pairB.privateKey, { kid: "key-b" });
        profile = await fetchProfileWithConfig(config, tokenB);
        assert.equal(profile.id, "u2");

        // Token signed with the removed key-a should now fail.
        await assert.rejects(() => fetchProfileWithConfig(config, tokenA), ProviderError);
      });
    });

    it("refetches once for an unknown kid and accepts a newly added key", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
          jwksCacheTtlMs: 60_000,
        };

        // Add key-b while key-a is still present (overlapping keys).
        const pairB = keyPair();
        server.addKey({ publicKey: pairB.publicKey, privateKey: pairB.privateKey, kid: "key-b" });

        const tokenB = signIdToken(validClaims({ sub: "u2" }), pairB.privateKey, { kid: "key-b" });
        const profile = await fetchProfileWithConfig(config, tokenB);
        assert.equal(profile.id, "u2");
      });
    });

    it("stops accepting a removed key after cache expiry", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
          jwksCacheTtlMs: 50,
        };

        const tokenA = signIdToken(validClaims({ sub: "u1" }), privateKey, { kid: "key-a" });
        const profile = await fetchProfileWithConfig(config, tokenA);
        assert.equal(profile.id, "u1");

        server.removeKey("key-a");
        await new Promise((resolve) => setTimeout(resolve, 100));

        await assert.rejects(() => fetchProfileWithConfig(config, tokenA), ProviderError);
      });
    });

    it("does not accept keys from an untrusted JWKS URL", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const untrustedServer = createOidcTestServer();
        await untrustedServer.start();
        const pairEvil = keyPair();
        untrustedServer.setKeys([
          { publicKey: pairEvil.publicKey, privateKey: pairEvil.privateKey, kid: "evil-key" },
        ]);

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
        };
        const evilToken = signIdToken(
          validClaims({ sub: "evil" }),
          pairEvil.privateKey,
          { kid: "evil-key" },
        );

        await assert.rejects(() => fetchProfileWithConfig(config, evilToken), ProviderError);

        await untrustedServer.stop();
      });
    });
  });

  describe("signing-key rotation within cached JWKS", () => {
    it("refreshes JWKS for a new kid before cache expiry", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const pairB = keyPair();

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
          jwksCacheTtlMs: 60_000,
        };

        // Prime and cache only key-a.
        const tokenA = signIdToken(validClaims({ sub: "u1" }), privateKey, { kid: "key-a" });
        const profileA = await fetchProfileWithConfig(config, tokenA);
        assert.equal(profileA.id, "u1");

        const fetchesAfterPrime = server.fetchCount;

        // Rotate within the cache lifetime: remove key-a, add key-b.
        server.removeKey("key-a");
        server.addKey({ publicKey: pairB.publicKey, privateKey: pairB.privateKey, kid: "key-b" });

        // key-b is unknown to the stale cache, so the validator must refetch.
        const tokenB = signIdToken(validClaims({ sub: "u2" }), pairB.privateKey, { kid: "key-b" });
        const profileB = await fetchProfileWithConfig(config, tokenB);
        assert.equal(profileB.id, "u2");
        assert.ok(
          server.fetchCount > fetchesAfterPrime,
          `expected a JWKS refresh, fetches stayed at ${server.fetchCount}`,
        );
      });
    });

    it("reuses the refetched key set for a subsequent token with the same new kid", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const pairB = keyPair();
        server.addKey({ publicKey: pairB.publicKey, privateKey: pairB.privateKey, kid: "key-b" });

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
          jwksCacheTtlMs: 60_000,
        };

        const tokenB = signIdToken(validClaims({ sub: "u2" }), pairB.privateKey, { kid: "key-b" });
        const profile = await fetchProfileWithConfig(config, tokenB);
        assert.equal(profile.id, "u2");

        const fetchesAfterFirst = server.fetchCount;

        // A second token signed with the same new kid must not trigger another
        // refresh because the refreshed set is now cached.
        const secondToken = signIdToken(validClaims({ sub: "u3" }), pairB.privateKey, { kid: "key-b" });
        const secondProfile = await fetchProfileWithConfig(config, secondToken);
        assert.equal(secondProfile.id, "u3");
        assert.equal(server.fetchCount, fetchesAfterFirst, "expected no additional JWKS fetch");
      });
    });

    it("rejects an invalid signature even when the kid is known", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const wrongKey = keyPair();
        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
        };
        const token = signIdToken(validClaims({ sub: "u1" }), wrongKey.privateKey, { kid: "key-a" });
        await assert.rejects(() => fetchProfileWithConfig(config, token), ProviderError);
      });
    });

    it("rejects a kid that remains unpublished after refresh", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
        };
        const other = keyPair();
        const token = signIdToken(validClaims({ sub: "u1" }), other.privateKey, { kid: "key-zz" });
        await assert.rejects(() => fetchProfileWithConfig(config, token), ProviderError);
      });
    });
  });

  describe("failure handling", () => {

    it("fails safely on a temporary JWKS outage", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
          jwksCacheTtlMs: 1,
        };

        const tokenA = signIdToken(validClaims({ sub: "u1" }), privateKey, { kid: "key-a" });
        const profile = await fetchProfileWithConfig(config, tokenA);
        assert.equal(profile.id, "u1");

        await new Promise((resolve) => setTimeout(resolve, 10));
        server.setFailNextFetch();

        await assert.rejects(() => fetchProfileWithConfig(config, tokenA), ProviderError);
      });
    });

    it("fails safely on a malformed JWKS response", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
          jwksCacheTtlMs: 1,
        };

        const tokenA = signIdToken(validClaims({ sub: "u1" }), privateKey, { kid: "key-a" });
        const profile = await fetchProfileWithConfig(config, tokenA);
        assert.equal(profile.id, "u1");

        await new Promise((resolve) => setTimeout(resolve, 10));
        server.setMalformedNextFetch();

        await assert.rejects(() => fetchProfileWithConfig(config, tokenA), ProviderError);
      });
    });

    it("does not cause an uncontrolled JWKS request storm for concurrent unknown kids", async () => {
      await withOidcServer(async (server) => {
        const { publicKey, privateKey } = keyPair();
        server.setKeys([{ publicKey, privateKey, kid: "key-a" }]);

        const config: OAuthProviderConfig = {
          clientId: "test-client-id",
          jwksUrl: `${server.baseUrl()}/.well-known/jwks.json`,
          jwksCacheTtlMs: 60_000,
        };

        const promises: Array<Promise<string>> = [];
        for (let i = 0; i < 10; i++) {
          const token = signIdToken(validClaims({ sub: `u${i}` }), privateKey, {
            kid: `unknown-kid-${i}`,
          });
          promises.push(
            (async () => {
              try {
                await fetchProfileWithConfig(config, token);
                return "accepted";
              } catch {
                return "rejected";
              }
            })(),
          );
        }

        const results = await Promise.all(promises);
        assert.ok(results.every((r) => r === "rejected"), "all unknown-kid tokens must be rejected");
        assert.ok(server.fetchCount <= 20, `expected bounded fetches, got ${server.fetchCount}`);
      });
    });
  });
});
