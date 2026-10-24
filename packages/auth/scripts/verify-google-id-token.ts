import http from "node:http";
import { URL } from "node:url";
import {
  createOAuth,
  pkceVerifier,
  randomState,
} from "../dist/index.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), ".env"),
});

const LIVE = process.env.OIDC_LIVE === "1";

if (!LIVE) {
  throw new Error(
    "Live Google verification is disabled. Set OIDC_LIVE=1 to enable it.",
  );
}

const clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";

const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";

const redirectUri =
  process.env.OIDC_REDIRECT_URI ??
  process.env.GOOGLE_REDIRECT_URI ??
  "http://localhost:3001/callback";

const scopes = process.env.OIDC_SCOPES ?? "openid email profile";
const requestedNonce = process.env.OIDC_NONCE ?? randomState();

if (!clientId) {
  throw new Error("GOOGLE_CLIENT_ID is required.");
}

if (!clientSecret) {
  throw new Error(
    "GOOGLE_CLIENT_SECRET is required. Set it in your environment; " +
      "do not hardcode credentials in this script.",
  );
}

if (!scopes.split(/\s+/).includes("openid")) {
  throw new Error("OIDC_SCOPES must include the openid scope.");
}

const parsedRedirect = new URL(redirectUri);

if (
  parsedRedirect.protocol !== "http:" ||
  !["localhost", "127.0.0.1"].includes(parsedRedirect.hostname)
) {
  throw new Error(
    "This live verification script only permits an HTTP localhost callback.",
  );
}

const port = Number(parsedRedirect.port || 80);
const pathname = parsedRedirect.pathname || "/";
const verifier = pkceVerifier();
const expectedState = randomState();

const oauth = createOAuth({
  providers: {
    google: {
      clientId,
      clientSecret,
      redirectUri,
      scopes: scopes.split(/\s+/).filter(Boolean),
      nonce: requestedNonce,
      pkce: true,
    },
  },
});

const { url, codeVerifier } = await oauth.authorize("google", {
  state: expectedState,
  redirectUri,
  codeVerifier: verifier,
  extraParams: { nonce: requestedNonce },
});

console.log("Open this URL in a browser and complete Google sign-in:");
console.log(url.toString());
console.log(`Waiting for callback on ${redirectUri} ...`);

const authorizationCode = await new Promise<string>(
  (resolve, reject) => {
    let settled = false;

    const callbackServer = http.createServer((req, res) => {
      const requestUrl = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );

      const finishResponse = (status: number, body: string) => {
        res.statusCode = status;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(body);
      };

      const finish = (error?: Error, code?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callbackServer.close();
        if (error) {
          reject(error);
        } else if (code) {
          resolve(code);
        } else {
          reject(new Error("OAuth callback completed without a code."));
        }
      };

      if (requestUrl.pathname !== pathname) {
        finishResponse(404, "Not found.");
        return;
      }

      const callbackState = requestUrl.searchParams.get("state");
      const code = requestUrl.searchParams.get("code");
      const error = requestUrl.searchParams.get("error");

      if (callbackState !== expectedState) {
        finishResponse(400, "OAuth state validation failed.");
        finish(new Error("OAuth state mismatch. Authorization was rejected."));
        return;
      }

      if (error) {
        finishResponse(400, "Google authorization failed.");
        finish(new Error(`Google authorization failed: ${error}`));
        return;
      }

      if (!code) {
        finishResponse(400, "Missing authorization code.");
        return;
      }

      finishResponse(
        200,
        "Authentication callback received. You can close this tab.",
      );
      finish(undefined, code);
    });

    const timeout = setTimeout(() => {
      finish(new Error("Timed out waiting for Google callback."));
    }, 300_000);

    callbackServer.on("error", (error) => {
      finish(
        new Error(`Could not start OAuth callback server: ${error.message}`),
      );
    });

    callbackServer.listen(port, "127.0.0.1");
  },
);

const tokenParams = new URLSearchParams({
  grant_type: "authorization_code",
  code: authorizationCode,
  client_id: clientId,
  redirect_uri: redirectUri,
});

if (clientSecret) {
  tokenParams.set("client_secret", clientSecret);
}

if (codeVerifier) {
  tokenParams.set("code_verifier", codeVerifier);
}

let tokenResponse: Response;

try {
  tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: tokenParams.toString(),
    signal: AbortSignal.timeout(30_000),
  });
} catch (error) {
  throw new Error(
    "Google token exchange request failed: " +
      (error instanceof Error ? error.message : String(error)),
  );
}

if (!tokenResponse.ok) {
  const errorBody = await tokenResponse.text();
  throw new Error(
    `Google token exchange failed (${tokenResponse.status}): ${errorBody}`,
  );
}

const tokens = (await tokenResponse.json()) as {
  id_token?: string;
  access_token?: string;
};

if (typeof tokens.id_token !== "string" || !tokens.id_token) {
  throw new Error(
    "Google did not return an ID token. Ensure the openid scope is requested.",
  );
}

const entry = oauth.get("google");

// Ensure the provider validates the nonce against this authorization request.
entry.config.nonce = requestedNonce;

const profile = await entry.provider.fetchProfile(entry.config, tokens);

if (typeof profile.id !== "string" || profile.id.length === 0) {
  throw new Error("Validated Google profile does not contain a subject.");
}

console.log("Google ID token validated successfully.");
console.log(`Provider: ${profile.provider ?? "google"}`);
console.log(`Subject: ${profile.id}`);

if (typeof profile.email === "string") {
  console.log(`Email: ${profile.email}`);
  console.log(`Email verified: ${profile.emailVerified === true}`);
}
