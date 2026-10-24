import * as shared from "./shared.js";


export const discord = shared.createProvider({
  id: "discord",
  name: "Discord",
  authorizationUrl: "https://discord.com/oauth2/authorize",
  tokenUrl: "https://discord.com/api/oauth2/token",
  userInfoUrl: "https://discord.com/api/users/@me",
  scopes: ["identify", "email"],
  profileMap: {
    id: "id",
    username: "username",
    email: "email",
    emailVerified: "verified",
    avatar: (data) =>
      typeof data.avatar === "string"
        ? `https://cdn.discordapp.com/avatars/${String(data.id)}/${data.avatar}.png`
        : undefined,
    locale: "locale",
  },
});