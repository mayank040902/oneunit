import * as shared from "./shared.js";


export const microsoft = shared.createProvider({
  id: "microsoft",
  name: "Microsoft",
  authorizationUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  userInfoUrl: "https://graph.microsoft.com/oidc/userinfo",
  scopes: ["openid", "profile", "email", "offline_access"],
  profileMap: {
    id: "sub",
    email: "email",
    name: "name",
    firstName: "given_name",
    lastName: "family_name",
    avatar: "picture",
  },
});