import * as shared from "./shared.js";


export const facebook = shared.createProvider({
  id: "facebook",
  name: "Facebook",
  authorizationUrl: "https://www.facebook.com/v21.0/dialog/oauth",
  tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
  userInfoUrl: "https://graph.facebook.com/me?fields=id,name,email,picture.type(large)",
  scopes: ["email", "public_profile"],
  profileMap: {
    id: "id",
    name: "name",
    email: "email",
    avatar: (data) => {
      const picture = data.picture;
      if (shared.isRecord(picture) && shared.isRecord(picture.data)) {
        return picture.data.url;
      }
      return undefined;
    },
  },
});