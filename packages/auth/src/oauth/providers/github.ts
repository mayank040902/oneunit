import { ProviderError } from "../../errors/index.js";
import { requestJson } from "../../utils.js";
import * as shared from "./shared.js";


export const github = shared.createProvider({
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

    const data = shared.isRecord(userRes.body) ? userRes.body : {};
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