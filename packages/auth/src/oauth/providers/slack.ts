import * as shared from "./shared.js";


export const slack = shared.createProvider({
  id: "slack",
  name: "Slack",
  authorizationUrl: "https://slack.com/oauth/v2/authorize",
  tokenUrl: "https://slack.com/api/oauth.v2.access",
  userInfoUrl: "https://slack.com/api/users.identity",
  scopes: ["identity.basic", "identity.email", "identity.avatar"],
  profileMap: {
    id: "user.id",
    name: "user.name",
    email: "user.email",
    avatar: "user.image_512",
  },
});