import * as shared from "./shared.js";


export const tiktok = shared.createProvider({
  id: "tiktok",
  name: "TikTok",
  authorizationUrl: "https://www.tiktok.com/v2/auth/authorize/",
  tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
  userInfoUrl: "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name",
  scopes: ["user.info.basic"],
  extraAuthParams: { response_type: "code" },
  profileMap: {
    id: "data.user.open_id",
    name: "data.user.display_name",
    avatar: "data.user.avatar_url",
  },
});