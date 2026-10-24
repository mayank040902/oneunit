import * as shared from "./shared.js";


export const instagram = shared.createProvider({
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