import * as shared from "./shared.js";


export const twitch = shared.createProvider({
  id: "twitch",
  name: "Twitch",
  authorizationUrl: "https://id.twitch.tv/oauth2/authorize",
  tokenUrl: "https://id.twitch.tv/oauth2/token",
  userInfoUrl: "https://api.twitch.tv/helix/users",
  scopes: ["user:read:email"],
  profileMap: {
    id: "data.0.id",
    username: "data.0.login",
    name: "data.0.display_name",
    email: "data.0.email",
    avatar: "data.0.profile_image_url",
  },
});