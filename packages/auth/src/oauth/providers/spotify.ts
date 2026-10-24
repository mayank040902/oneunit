import * as shared from "./shared.js";


export const spotify = shared.createProvider({
  id: "spotify",
  name: "Spotify",
  authorizationUrl: "https://accounts.spotify.com/authorize",
  tokenUrl: "https://accounts.spotify.com/api/token",
  userInfoUrl: "https://api.spotify.com/v1/me",
  scopes: ["user-read-email", "user-read-private"],
  tokenAuthMethod: "basic",
  profileMap: {
    id: "id",
    email: "email",
    name: "display_name",
    avatar: (data) => {
      const images = data.images;
      if (Array.isArray(images) && shared.isRecord(images[0])) {
        return images[0].url;
      }
      return undefined;
    },
    profileUrl: "external_urls.spotify",
  },
});