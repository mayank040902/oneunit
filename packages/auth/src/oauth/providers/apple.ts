import { ProviderError } from "../../errors/index.js";
import * as shared from "./shared.js";


export const apple = shared.createProvider({
  id: "apple",
  name: "Apple",
  authorizationUrl: "https://appleid.apple.com/auth/authorize",
  tokenUrl: "https://appleid.apple.com/auth/token",
  scopes: ["name", "email"],
  extraAuthParams: { response_mode: "form_post" },
  async parseProfile(tokens, config) {
    const idToken = tokens?.id_token;
    if (!idToken) {
      return { provider: "apple", raw: tokens };
    }

    // Apple is the only built-in provider whose profile comes from a token in
    // the response rather than a server-side userinfo call, so the token is
    // verified here. See ARCHITECTURE.md for why the signature is checked even
    // though the token usually arrives over a server-side TLS exchange.
    const payload = await shared.verifyIdToken(idToken, config, "Apple");

    const iss = typeof payload.iss === "string" ? payload.iss : undefined;
    if (iss !== shared.APPLE_ISSUER) {
      throw new ProviderError(`Apple id_token has an unexpected issuer: ${String(iss)}`);
    }

    const aud = payload.aud;
    const clientId = config.clientId;
    if (clientId) {
      const matches = Array.isArray(aud) ? aud.includes(clientId) : aud === clientId;
      if (!matches) {
        throw new ProviderError("Apple id_token audience does not match the configured clientId");
      }
    }

    // Required rather than checked when present. A token with no usable exp
    // would otherwise be treated as never expiring, which turns a leaked token
    // into permanent access.
    const exp = payload.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) {
      throw new ProviderError("Apple id_token is missing a numeric exp claim");
    }
    if (exp <= Math.floor(Date.now() / 1000)) {
      throw new ProviderError("Apple id_token has expired");
    }

    // Apple only returns these on the first authorization for an account, so
    // callers must not depend on them being present.
    return {
      provider: "apple",
      id: payload.sub as string | undefined,
      email: payload.email as string | undefined,
      emailVerified: payload.email_verified === "true" || payload.email_verified === true,
      raw: { tokens, claims: payload },
    };
  },
});