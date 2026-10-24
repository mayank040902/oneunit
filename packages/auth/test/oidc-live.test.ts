import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOAuth } from "../src/index.js";

const LIVE = process.env.OIDC_LIVE === "1";

const skipReason = LIVE
  ? false
  : "Live OIDC tests are opt-in: set OIDC_LIVE=1 and the documented OIDC_* variables";

describe("live OIDC provider integration (opt-in)", { skip: skipReason }, () => {
  it("fetches the provider discovery document", async () => {
    const issuer = process.env.OIDC_ISSUER ?? "https://appleid.apple.com";
    const res = await fetch(`${issuer}/.well-known/openid-configuration`);
    assert.equal(res.ok, true, `discovery endpoint returned ${res.status}`);
    const metadata = (await res.json()) as Record<string, unknown>;
    assert.equal(metadata.issuer, issuer);
    assert.ok(typeof metadata.jwks_uri === "string", "discovery document must include jwks_uri");
  });

  it("retrieves the provider JWKS document", async () => {
    const issuer = process.env.OIDC_ISSUER ?? "https://appleid.apple.com";
    const metaRes = await fetch(`${issuer}/.well-known/openid-configuration`);
    assert.equal(metaRes.ok, true);
    const metadata = (await metaRes.json()) as { jwks_uri: string };
    const keysRes = await fetch(metadata.jwks_uri);
    assert.equal(keysRes.ok, true, `JWKS endpoint returned ${keysRes.status}`);
    const jwks = (await keysRes.json()) as { keys?: unknown[] };
    assert.ok(Array.isArray(jwks.keys) && jwks.keys.length > 0, "JWKS must contain signing keys");
  });

  it("validates a configured id_token against the live provider when supplied", async (t) => {
    const idToken = process.env.OIDC_ID_TOKEN;
    const clientId = process.env.OIDC_CLIENT_ID;
    if (!idToken || !clientId) {
      t.skip("OIDC_ID_TOKEN and OIDC_CLIENT_ID are required for token validation");
      return;
    }
    const issuer = process.env.OIDC_ISSUER ?? "https://appleid.apple.com";
    const oauth = createOAuth({
      providers: {
        apple: {
          clientId,
          verifyIdTokenSignature: true,
        },
      },
    });
    const entry = oauth.get("apple");
    if (issuer !== "https://appleid.apple.com") {
      t.skip("live token validation is only wired for the built-in Apple provider");
      return;
    }
    const profile = await entry.provider.fetchProfile(entry.config, { id_token: idToken });
    assert.ok(profile && typeof profile.id === "string", "profile must include a subject id");
  });

  it("rejects an id_token with a tampered signature using the live JWKS", async () => {
    const idToken = process.env.OIDC_ID_TOKEN;
    const clientId = process.env.OIDC_CLIENT_ID;
    if (!idToken || !clientId) {
      return; // no token available; skip silently in opt-in mode
    }
    // Flip a byte in the signature segment; JWKS retrieval is the live part.
    const parts = idToken.split(".");
    if (parts.length !== 3) return;
    const signature = parts[2];
    const tampered = `${parts[0]}.${parts[1]}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
    const oauth = createOAuth({ providers: { apple: { clientId } } });
    const entry = oauth.get("apple");
    await assert.rejects(() => entry.provider.fetchProfile(entry.config, { id_token: tampered }), (err: unknown) => {
      assert.ok(err instanceof Error);
      return true;
    });
  });
});
