import * as shared from "./shared.js";


export const reddit = shared.createProvider({
  id: "reddit",
  name: "Reddit",
  authorizationUrl: "https://www.reddit.com/api/v1/authorize",
  tokenUrl: "https://www.reddit.com/api/v1/access_token",
  userInfoUrl: "https://oauth.reddit.com/api/v1/me",
  scopes: ["identity"],
  tokenAuthMethod: "basic",
  extraAuthParams: { duration: "permanent" },
  userInfoHeaders: { "user-agent": "@oneunit/auth" },
  profileMap: {
    id: "id",
    username: "name",
    avatar: "icon_img",
  },
});