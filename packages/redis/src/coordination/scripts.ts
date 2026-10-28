 
import { Redis } from "ioredis";

export async function runLua(
  client: Redis,
  script: string,
  keys: string[],
  args: Array<string | number>,
): Promise<unknown> {
  return client.eval(script, keys.length, ...keys, ...args.map((a) => String(a)));
}

export const redisTimeMsLua = `
local t = redis.call('TIME')
return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`;

export function nowMsLua(): string {
  return redisTimeMsLua.trim();
}
