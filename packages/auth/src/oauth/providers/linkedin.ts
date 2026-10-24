import * as shared from "./shared.js";


export const linkedin = shared.createProvider({
  id: "linkedin",
  name: "LinkedIn",
  authorizationUrl: "https://www.linkedin.com/oauth/v2/authorization",
  tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
  userInfoUrl: "https://api.linkedin.com/v2/userinfo",
  scopes: ["openid", "profile", "email"],
  profileMap: {
    id: "sub",
    name: "name",
    email: "email",
    emailVerified: "email_verified",
    avatar: "picture",
    locale: "locale",
  },
});