import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { generateKeyPairSync, sign as signRSA } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { google, ProviderError } from "../src/index.js";
import type { OAuthProviderConfig } from "../src/index.js";

const GOOGLE_ISSUER = "https://accounts.google.com";
const CLIENT_ID = "test-google-client-id";

function buildJwks(keys: Array<{ publicKey: KeyObject; kid: string }>) {
  return {
    keys: keys.map(({ publicKey, kid }) => ({
      ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>),
      kid,
      alg: "RS256",
      use: "sig",
    })),
  };
}

function signIdToken(
  claims: Record<string, unknown>,
  privateKey: KeyObject,
  options: { kid?: string; alg?: string } = {},
) {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header: Record<string, unknown> = { alg: options.alg ?? "RS256" };
  if (options.kid !== undefined) header.kid = options.kid;
  const head = b64(header);
  const body = b64(claims);
  const signature = signRSA("RSA-SHA256", Buffer.from(`${head}.${body}`, "utf8"), privateKey);
  return `${head}.${body}.${signature.toString("base64url")}`;
}

const now = () => Math.floor(Date.now() / 1000);

function claims(over: Record<string, unknown> = {}) {
  return {
    iss: GOOGLE_ISSUER,
    aud: CLIENT_ID,
    sub: "google-subject",
    email: "user@example.com",
    email_verified: true,
    exp: now() + 3600,
    iat: now(),
    nonce: "test-nonce",
    ...over,
  };
}

function keyPair() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

function createJwksServer() {
  let currentKeys: Array<{ publicKey: KeyObject; privateKey: KeyObject; kid: string }> = [];
  let failNext = false;
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${(server.address() as { port: number }).port}`);
    if (url.pathname !== "/.well-known/jwks.json") {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (failNext) {
      failNext = false;
      res.statusCode = 503;
      res.end(JSON.stringify({ error: "temporary outage" }));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(buildJwks(currentKeys)));
  });

  return {
    start: () =>
      new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port))),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
    setKeys: (keys: Array<{ publicKey: KeyObject; privateKey: KeyObject; kid: string }>) => {
      currentKeys = keys;
    },
    setFailNext: () => {
      failNext = true;
    },
    url: (port: number) => `http://127.0.0.1:${port}/.well-known/jwks.json`,
  };
}

describe("Google OIDC id_token verification (deterministic)", () => {
  it("accepts a correctly signed Google id_token", async () => {
    const { publicKey, privateKey } = keyPair();
    const instance = createJwksServer();
    const port = await instance.start();
    instance.setKeys([{ publicKey, privateKey, kid: "google-key" }]);
    const config: OAuthProviderConfig = {
      clientId: CLIENT_ID,
      jwksUrl: instance.url(port),
      nonce: "test-nonce",
    };
    const token = signIdToken(claims(), privateKey, { kid: "google-key" });
    const profile = await google.fetchProfile(config, { id_token: token });
    assert.equal(profile.id, "google-subject");
    await instance.stop();
  });

  it("rejects an invalid signature", async () => {
    const { publicKey, privateKey } = keyPair();
    const other = keyPair();
    const instance = createJwksServer();
    const port = await instance.start();
    instance.setKeys([{ publicKey, privateKey, kid: "google-key" }]);
    const config: OAuthProviderConfig = { clientId: CLIENT_ID, jwksUrl: instance.url(port) };
    const token = signIdToken(claims(), other.privateKey, { kid: "google-key" });
    await assert.rejects(() => google.fetchProfile(config, { id_token: token }), ProviderError);
    await instance.stop();
  });

  it("rejects alg none", async () => {
    const { publicKey, privateKey } = keyPair();
    const instance = createJwksServer();
    const port = await instance.start();
    instance.setKeys([{ publicKey, privateKey, kid: "google-key" }]);
    const config: OAuthProviderConfig = { clientId: CLIENT_ID, jwksUrl: instance.url(port) };
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${b64({ alg: "none", kid: "google-key" })}.${b64(claims())}.`;
    await assert.rejects(() => google.fetchProfile(config, { id_token: unsigned }), ProviderError);
    await instance.stop();
  });

  it("rejects a wrong issuer", async () => {
    const { publicKey, privateKey } = keyPair();
    const instance = createJwksServer();
    const port = await instance.start();
    instance.setKeys([{ publicKey, privateKey, kid: "google-key" }]);
    const config: OAuthProviderConfig = { clientId: CLIENT_ID, jwksUrl: instance.url(port) };
    const token = signIdToken(claims({ iss: "https://evil.example" }), privateKey, { kid: "google-key" });
    await assert.rejects(() => google.fetchProfile(config, { id_token: token }), ProviderError);
    await instance.stop();
  });

  it("rejects a wrong audience", async () => {
    const { publicKey, privateKey } = keyPair();
    const instance = createJwksServer();
    const port = await instance.start();
    instance.setKeys([{ publicKey, privateKey, kid: "google-key" }]);
    const config: OAuthProviderConfig = { clientId: CLIENT_ID, jwksUrl: instance.url(port) };
    const token = signIdToken(claims({ aud: "another-client" }), privateKey, { kid: "google-key" });
    await assert.rejects(() => google.fetchProfile(config, { id_token: token }), ProviderError);
    await instance.stop();
  });

  it("rejects an expired token", async () => {
    const { publicKey, privateKey } = keyPair();
    const instance = createJwksServer();
    const port = await instance.start();
    instance.setKeys([{ publicKey, privateKey, kid: "google-key" }]);
    const config: OAuthProviderConfig = { clientId: CLIENT_ID, jwksUrl: instance.url(port) };
    const token = signIdToken(claims({ exp: now() - 60 }), privateKey, { kid: "google-key" });
    await assert.rejects(() => google.fetchProfile(config, { id_token: token }), ProviderError);
    await instance.stop();
  });

  it("rejects a token missing exp", async () => {
    const { publicKey, privateKey } = keyPair();
    const instance = createJwksServer();
    const port = await instance.start();
    instance.setKeys([{ publicKey, privateKey, kid: "google-key" }]);
    const config: OAuthProviderConfig = { clientId: CLIENT_ID, jwksUrl: instance.url(port) };
    const { exp: _exp, ...noExp } = claims();
    const token = signIdToken(noExp, privateKey, { kid: "google-key" });
    await assert.rejects(() => google.fetchProfile(config, { id_token: token }), ProviderError);
    await instance.stop();
  });

  it("rejects an unknown kid", async () => {
    const { publicKey, privateKey } = keyPair();
    const instance = createJwksServer();
    const port = await instance.start();
    instance.setKeys([{ publicKey, privateKey, kid: "google-key" }]);
    const config: OAuthProviderConfig = { clientId: CLIENT_ID, jwksUrl: instance.url(port) };
    const token = signIdToken(claims(), privateKey, { kid: "unknown-kid" });
    await assert.rejects(() => google.fetchProfile(config, { id_token: token }), ProviderError);
    await instance.stop();
  });

  it("rejects a nonce mismatch", async () => {
    const { publicKey, privateKey } = keyPair();
    const instance = createJwksServer();
    const port = await instance.start();
    instance.setKeys([{ publicKey, privateKey, kid: "google-key" }]);
    const config: OAuthProviderConfig = {
      clientId: CLIENT_ID,
      jwksUrl: instance.url(port),
      nonce: "wrong-nonce",
    };
    const token = signIdToken(claims(), privateKey, { kid: "google-key" });
    await assert.rejects(() => google.fetchProfile(config, { id_token: token }), ProviderError);
    await instance.stop();
  });

  it("fails safely on a JWKS outage", async () => {
    const { publicKey, privateKey } = keyPair();
    const instance = createJwksServer();
    const port = await instance.start();
    instance.setKeys([{ publicKey, privateKey, kid: "google-key" }]);
    const config: OAuthProviderConfig = {
      clientId: CLIENT_ID,
      jwksUrl: instance.url(port),
      jwksCacheTtlMs: 1,
    };
    const token = signIdToken(claims(), privateKey, { kid: "google-key" });
    await google.fetchProfile(config, { id_token: token });
    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.setFailNext();
    await assert.rejects(() => google.fetchProfile(config, { id_token: token }), ProviderError);
    await instance.stop();
  });
});
