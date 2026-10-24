import type { OAuthProvider } from "../../types/index.js";
import { ValidationError } from "../../errors/index.js";

import { github } from "./github.js";
import { microsoft } from "./microsoft.js";
import { twitch } from "./twitch.js";
import { slack } from "./slack.js";
import { facebook } from "./facebook.js";
import { spotify } from "./spotify.js";
import { tiktok } from "./tiktok.js";
import { twitter } from "./twitter.js";
import { google } from "./google.js";
import { linkedin } from "./linkedin.js";
import { discord } from "./discord.js";
import { instagram } from "./instagram.js";
import { apple } from "./apple.js";
import { reddit } from "./reddit.js";

export * from "./shared.js";
export { reddit } from "./reddit.js";
export { github } from "./github.js";
export { microsoft } from "./microsoft.js";
export { twitch } from "./twitch.js";
export { slack } from "./slack.js";
export { facebook } from "./facebook.js";
export { spotify } from "./spotify.js";
export { tiktok } from "./tiktok.js";
export { twitter } from "./twitter.js";
export { google } from "./google.js";
export { linkedin } from "./linkedin.js";
export { discord } from "./discord.js";
export { instagram } from "./instagram.js";
export { apple } from "./apple.js";

export const builtinProviders = Object.freeze({
  google,
  github,
  instagram,
  facebook,
  twitter,
  x: twitter,
  discord,
  apple,
  linkedin,
  microsoft,
  reddit,
  twitch,
  slack,
  spotify,
  tiktok,
});

export function getProvider(id: string): OAuthProvider {
  const provider = builtinProviders[String(id).toLowerCase() as keyof typeof builtinProviders];
  if (!provider) {
    throw new ValidationError(`Unknown OAuth provider: ${id}`);
  }
  return provider;
}