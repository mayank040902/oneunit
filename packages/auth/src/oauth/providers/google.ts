import { ProviderError } from "../../errors/index.js";
import { requestJson } from "../../utils.js";
import * as shared from "./shared.js";


export const google = shared.createProvider({
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
        ...shared.mapProfile(response.body, {
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

    const payload = await shared.verifyIdToken(idToken, config, "Google", shared.GOOGLE_JWKS_URL);

    const iss = typeof payload.iss === "string" ? payload.iss : undefined;
    if (iss !== shared.GOOGLE_ISSUER) {
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