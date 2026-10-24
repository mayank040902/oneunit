import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { ProviderError, ValidationError } from "../../errors/index.js";
import type {
  AuthorizationUrlOptions,
  AuthorizationUrlResult,
  ExchangeCodeOptions,
  OAuthProfile,
  OAuthProvider,
  OAuthProviderConfig,
  OAuthTokens,
  ProfileMapValue,
  ProviderDefinition,
} from "../../types/index.js";
import { buildUrl, formEncode, requestJson } from "../../utils.js";

export function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function requireConfig(config: OAuthProviderConfig, keys: Array<keyof OAuthProviderConfig>): void {
  for (const key of keys) {
    if (!config[key]) {
      throw new ValidationError(`OAuth provider is missing ${String(key)}`);
    }
  }
}

export function mapProfile(source: unknown, mapping: Record<string, ProfileMapValue>): Record<string, unknown> {
  const profile: Record<string, unknown> = {};
  const record = isRecord(source) ? source : {};
  for (const [key, path] of Object.entries(mapping)) {
    profile[key] = typeof path === "function" ? path(record) : getPath(record, path);
  }
  return profile;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getPath(object: unknown, path: string): unknown {
  if (!path) {
    return undefined;
  }
  return String(path).split(".").reduce<unknown>((acc, key) => {
    if (!isRecord(acc) && !Array.isArray(acc)) {
      return undefined;
    }
    return (acc as Record<string, unknown>)[key];
  }, object);
}

function errorMessage(body: unknown, fallback: string): string {
  if (isRecord(body)) {
    if (typeof body.error_description === "string") return body.error_description;
    if (typeof body.error === "string") return body.error;
  }
  return fallback;
}

export function createProvider(definition: ProviderDefinition): OAuthProvider {
  const {
    id,
    name = id,
    authorizationUrl,
    tokenUrl,
    userInfoUrl,
    scopes = [],
    profileMap = {},
    tokenAuthMethod = "body",
    pkce = false,
    extraAuthParams = {},
    extraTokenParams = {},
    userInfoHeaders = {},
    parseProfile,
  } = definition;

  if (!id || !authorizationUrl || !tokenUrl) {
    throw new ValidationError("Provider requires id, authorizationUrl, and tokenUrl");
  }

  return {
    id,
    name,
    authorizationUrl,
    tokenUrl,
    userInfoUrl,
    scopes,
    pkce,
    tokenAuthMethod,

    createAuthorizationUrl(
      config: OAuthProviderConfig,
      { state, redirectUri, codeVerifier, extraParams = {} }: AuthorizationUrlOptions = {},
    ): AuthorizationUrlResult {
      requireConfig(config, ["clientId"]);
      const params: Record<string, unknown> = {
        client_id: config.clientId,
        redirect_uri: redirectUri ?? config.redirectUri,
        response_type: "code",
        scope: (config.scopes ?? scopes).join(" "),
        state,
        ...extraAuthParams,
        ...(config.extraAuthParams ?? {}),
        ...extraParams,
      };

      let verifier: string | undefined;
      if (pkce || config.pkce) {
        verifier = codeVerifier ?? pkceVerifier();
        params.code_challenge = pkceChallenge(verifier);
        params.code_challenge_method = "S256";
      }

      return {
        url: buildUrl(authorizationUrl, "", params),
        state,
        codeVerifier: verifier,
      };
    },

    async exchangeCode(
      config: OAuthProviderConfig,
      { code, redirectUri, codeVerifier }: ExchangeCodeOptions = {},
    ): Promise<OAuthTokens> {
      requireConfig(config, ["clientId"]);
      if (!code) {
        throw new ValidationError("Authorization code is required");
      }

      const body: Record<string, unknown> = {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri ?? config.redirectUri,
        ...extraTokenParams,
        ...(config.extraTokenParams ?? {}),
      };

      if (codeVerifier) {
        body.code_verifier = codeVerifier;
      }

      const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      };

      if ((config.tokenAuthMethod ?? tokenAuthMethod) === "basic") {
        const credentials = Buffer.from(`${config.clientId}:${config.clientSecret ?? ""}`).toString("base64");
        headers.authorization = `Basic ${credentials}`;
      } else {
        body.client_id = config.clientId;
        if (config.clientSecret) {
          body.client_secret = config.clientSecret;
        }
      }

      const response = await requestJson(tokenUrl, {
        method: "POST",
        headers,
        body: formEncode(body),
      });

      if (!response.ok) {
        throw new ProviderError(errorMessage(response.body, `${name} token exchange failed`), {
          status: response.status,
        });
      }

      return (isRecord(response.body) ? response.body : {}) as OAuthTokens;
    },

    async fetchProfile(config: OAuthProviderConfig, tokens: OAuthTokens): Promise<OAuthProfile> {
      if (typeof parseProfile === "function") {
        return parseProfile(tokens, config);
      }

      if (!userInfoUrl) {
        return { provider: id, ...mapProfile(tokens, profileMap) };
      }

      const accessToken = tokens?.access_token;
      if (!accessToken) {
        throw new ProviderError(`${name} did not return an access token`);
      }

      const response = await requestJson(userInfoUrl, {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...userInfoHeaders,
          ...(config.userInfoHeaders ?? {}),
        },
      });

      if (!response.ok) {
        throw new ProviderError(errorMessage(response.body, `${name} profile fetch failed`), {
          status: response.status,
        });
      }

      return {
        raw: response.body,
        provider: id,
        ...mapProfile(response.body, profileMap),
      };
    },
  };
}

export const google = createProvider({
  id: "google",
  name: "Google",
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
  scopes: ["openid", "email", "profile"],
  extraAuthParams: { access_type: "offline", prompt: "consent" },
  profileMap: {
    id: "sub",
    email: "email",
    emailVerified: "email_verified",
    name: "name",
    firstName: "given_name",
    lastName: "family_name",
    avatar: "picture",
    locale: "locale",
  },
  async parseProfile(tokens, config) {
    const idToken = tokens?.id_token;
    if (!idToken) {
      const accessToken = tokens?.access_token;
      if (!accessToken) {
        throw new ProviderError("Google did not return an access token");
      }
      const response = await requestJson("https://openidconnect.googleapis.com/v1/userinfo", {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(config.userInfoHeaders ?? {}),
        },
      });
      if (!response.ok) {
        throw new ProviderError(`Google profile fetch failed`, { status: response.status });
      }
      return {
        raw: response.body,
        provider: "google",
        ...mapProfile(response.body, {
          id: "sub",
          email: "email",
          emailVerified: "email_verified",
          name: "name",
          firstName: "given_name",
          lastName: "family_name",
          avatar: "picture",
          locale: "locale",
        }),
      };
    }

    const payload = await verifyIdToken(idToken, config, "Google", GOOGLE_JWKS_URL);

    const iss = typeof payload.iss === "string" ? payload.iss : undefined;
    if (iss !== GOOGLE_ISSUER) {
      throw new ProviderError(`Google id_token has an unexpected issuer: ${String(iss)}`);
    }

    const aud = payload.aud;
    const clientId = config.clientId;
    if (clientId) {
      const matches = Array.isArray(aud) ? aud.includes(clientId) : aud === clientId;
      if (!matches) {
        throw new ProviderError("Google id_token audience does not match the configured clientId");
      }
    }

    const exp = payload.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) {
      throw new ProviderError("Google id_token is missing a numeric exp claim");
    }
    if (exp <= Math.floor(Date.now() / 1000)) {
      throw new ProviderError("Google id_token has expired");
    }

    if (typeof config.nonce === "string" && config.nonce.length > 0) {
      if (payload.nonce !== config.nonce) {
        throw new ProviderError("Google id_token nonce does not match the requested nonce");
      }
    }

    return {
      provider: "google",
      id: payload.sub as string | undefined,
      email: payload.email as string | undefined,
      emailVerified: payload.email_verified === true || payload.email_verified === "true",
      name: payload.name as string | undefined,
      givenName: payload.given_name as string | undefined,
      familyName: payload.last_name as string | undefined,
      avatar: payload.picture as string | undefined,
      locale: payload.locale as string | undefined,
      raw: { tokens, claims: payload },
    };
  },
});

export const github = createProvider({
  id: "github",
  name: "GitHub",
  authorizationUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  userInfoUrl: "https://api.github.com/user",
  scopes: ["read:user", "user:email"],
  userInfoHeaders: { "user-agent": "@oneunit/auth" },
  async parseProfile(tokens) {
    const accessToken = tokens?.access_token;
    if (!accessToken) {
      throw new ProviderError("GitHub did not return an access token");
    }

    const headers = {
      authorization: `Bearer ${accessToken}`,
      "user-agent": "@oneunit/auth",
      accept: "application/vnd.github+json",
    };
    const userRes = await requestJson("https://api.github.com/user", { headers });
    if (!userRes.ok) {
      throw new ProviderError("GitHub profile fetch failed", { status: userRes.status });
    }

    const data = isRecord(userRes.body) ? userRes.body : {};
    let email = typeof data.email === "string" ? data.email : undefined;
    if (!email) {
      const emailsRes = await requestJson("https://api.github.com/user/emails", { headers });
      if (emailsRes.ok && Array.isArray(emailsRes.body)) {
        const emails = emailsRes.body as Array<{ email?: string; primary?: boolean; verified?: boolean }>;
        const primary = emails.find((item) => item.primary && item.verified)
          ?? emails.find((item) => item.verified)
          ?? emails[0];
        email = primary?.email;
      }
    }

    return {
      provider: "github",
      id: data.id as string | number | undefined,
      username: data.login as string | undefined,
      name: data.name as string | undefined,
      email,
      avatar: data.avatar_url as string | undefined,
      profileUrl: data.html_url as string | undefined,
      raw: data,
    };
  },
});

export const instagram = createProvider({
  id: "instagram",
  name: "Instagram",
  authorizationUrl: "https://api.instagram.com/oauth/authorize",
  tokenUrl: "https://api.instagram.com/oauth/access_token",
  userInfoUrl: "https://graph.instagram.com/me?fields=id,username,account_type,name",
  scopes: ["user_profile"],
  profileMap: {
    id: "id",
    username: "username",
    name: "name",
    accountType: "account_type",
  },
});

export const facebook = createProvider({
  id: "facebook",
  name: "Facebook",
  authorizationUrl: "https://www.facebook.com/v21.0/dialog/oauth",
  tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
  userInfoUrl: "https://graph.facebook.com/me?fields=id,name,email,picture.type(large)",
  scopes: ["email", "public_profile"],
  profileMap: {
    id: "id",
    name: "name",
    email: "email",
    avatar: (data) => {
      const picture = data.picture;
      if (isRecord(picture) && isRecord(picture.data)) {
        return picture.data.url;
      }
      return undefined;
    },
  },
});

export const twitter = createProvider({
  id: "twitter",
  name: "X",
  authorizationUrl: "https://twitter.com/i/oauth2/authorize",
  tokenUrl: "https://api.twitter.com/2/oauth2/token",
  userInfoUrl: "https://api.twitter.com/2/users/me?user.fields=profile_image_url,name,username",
  scopes: ["tweet.read", "users.read", "offline.access"],
  pkce: true,
  tokenAuthMethod: "basic",
  extraAuthParams: { code_challenge_method: "S256" },
  profileMap: {
    id: "data.id",
    username: "data.username",
    name: "data.name",
    avatar: "data.profile_image_url",
  },
});

export const discord = createProvider({
  id: "discord",
  name: "Discord",
  authorizationUrl: "https://discord.com/oauth2/authorize",
  tokenUrl: "https://discord.com/api/oauth2/token",
  userInfoUrl: "https://discord.com/api/users/@me",
  scopes: ["identify", "email"],
  profileMap: {
    id: "id",
    username: "username",
    email: "email",
    emailVerified: "verified",
    avatar: (data) =>
      typeof data.avatar === "string"
        ? `https://cdn.discordapp.com/avatars/${String(data.id)}/${data.avatar}.png`
        : undefined,
    locale: "locale",
  },
});

export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
export const GOOGLE_ISSUER = "https://accounts.google.com";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const DEFAULT_JWKS_TTL_MS = 60 * 60 * 1000;

/**
 * Fetched signing keys, shared across providers and kept past a single request
 * so a burst of logins does not turn into a burst of JWKS traffic. An entry
 * whose kid is missing triggers a single refetch before failing, which is what
 * makes a routine Apple key rotation invisible to callers.
 */
const jwksCache = new Map<string, { set: Record<string, unknown>; expiresAt: number }>();
const jwksInflight = new Map<string, Promise<Record<string, unknown>>>();

function clearJwksCache(url: string): void {
  jwksCache.delete(url);
}

async function refreshJwksSingleFlight(url: string, ttlMs: number): Promise<Record<string, unknown>> {
  const existing = jwksInflight.get(url);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    clearJwksCache(url);
    return loadJwks(url, ttlMs, true);
  })();
  jwksInflight.set(url, promise);
  try {
    return await promise;
  } finally {
    jwksInflight.delete(url);
  }
}

async function loadJwks(url: string, ttlMs: number, refresh: boolean): Promise<Record<string, unknown>> {
  if (!refresh) {
    const cached = jwksCache.get(url);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.set;
    }
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new ProviderError(`Could not fetch signing keys from ${url}: HTTP ${response.status}`);
  }
  let set: Record<string, unknown>;
  try {
    set = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new ProviderError(`Could not parse JWKS response from ${url}`);
  }
  if (!set || typeof set !== "object" || Array.isArray(set) || !Array.isArray(set.keys)) {
    throw new ProviderError(`JWKS response from ${url} is not a valid JWKS object`);
  }
  jwksCache.set(url, { set, expiresAt: Date.now() + ttlMs });
  return set;
}

async function resolveJwks(config: OAuthProviderConfig, defaultJwksUrl: string = APPLE_JWKS_URL): Promise<Record<string, unknown>> {
  if (typeof config.jwks === "function") {
    return (await config.jwks()) as Record<string, unknown>;
  }
  if (config.jwks && typeof config.jwks === "object") {
    return config.jwks;
  }
  const url = typeof config.jwksUrl === "string" ? config.jwksUrl : defaultJwksUrl;
  const ttl = typeof config.jwksCacheTtlMs === "number" ? config.jwksCacheTtlMs : DEFAULT_JWKS_TTL_MS;
  return loadJwks(url, ttl, false);
}

function findJwk(set: Record<string, unknown>, kid: string): Record<string, unknown> | undefined {
  const keys = set.keys;
  if (!Array.isArray(keys)) {
    return undefined;
  }
  return keys.find((entry): entry is Record<string, unknown> =>
    typeof entry === "object" && entry !== null && (entry as { kid?: unknown }).kid === kid);
}

/**
 * Verifies the RS256 signature over an id_token's header and payload against
 * the provider's published keys, and returns the decoded payload.
 *
 * The claims inside a token are unauthenticated until this runs. Checking `iss`
 * or `aud` on an unverified payload only proves the payload says what the
 * attacker wants it to say, so the signature has to be checked first and the
 * claim checks read the verified bytes.
 */
export async function verifyIdToken(
  idToken: string,
  config: OAuthProviderConfig,
  providerName: string,
  defaultJwksUrl: string = APPLE_JWKS_URL,
): Promise<Record<string, unknown>> {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new ProviderError(`${providerName} id_token is not a well-formed JWT`);
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  let header: { alg?: unknown; kid?: unknown };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as { alg?: unknown; kid?: unknown };
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new ProviderError(`${providerName} id_token has undecodable segments`);
  }

  if (config.verifyIdTokenSignature === false) {
    return payload;
  }

  // Pinning the algorithm is what stops the classic JWT confusion attack: a
  // token declaring "alg": "none", or an HMAC algorithm keyed with the RSA
  // public key, would otherwise be accepted.
  if (header.alg !== "RS256") {
    throw new ProviderError(`${providerName} id_token must be signed with RS256, got ${String(header.alg)}`);
  }
  if (typeof header.kid !== "string" || header.kid.length === 0) {
    throw new ProviderError(`${providerName} id_token is missing a kid`);
  }

  const ttl = typeof config.jwksCacheTtlMs === "number" ? config.jwksCacheTtlMs : DEFAULT_JWKS_TTL_MS;
  const url = typeof config.jwksUrl === "string" ? config.jwksUrl : defaultJwksUrl;
  const usesCache = typeof config.jwks !== "function" && typeof config.jwks !== "object";

  let jwk = findJwk(await resolveJwks(config, defaultJwksUrl), header.kid);
  if (!jwk && usesCache) {
    // An unknown kid is either a rotation or an attack. Refetch once, since a
    // rotation is the common case and the attacker has to survive the retry.
    // Concurrent verifications share one in-flight refresh so an unknown kid
    // cannot amplify into an unbounded request storm.
    jwk = findJwk(await refreshJwksSingleFlight(url, ttl), header.kid);
  }
  if (!jwk) {
    throw new ProviderError(`${providerName} id_token was signed by an unknown key (kid: ${header.kid})`);
  }

  let publicKey;
  try {
    publicKey = createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    throw new ProviderError(`${providerName} id_token signing key could not be read`);
  }

  const signed = Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8");
  let signature: Buffer;
  try {
    signature = Buffer.from(encodedSignature, "base64url");
  } catch {
    throw new ProviderError(`${providerName} id_token has an undecodable signature`);
  }
  if (signature.length === 0 || !verifySignature("RSA-SHA256", signed, publicKey, signature)) {
    throw new ProviderError(`${providerName} id_token signature is invalid`);
  }

  return payload;
}
