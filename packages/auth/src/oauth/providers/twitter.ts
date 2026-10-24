import * as shared from "./shared.js";


export const twitter = shared.createProvider({
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