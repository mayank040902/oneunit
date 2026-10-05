import "fastify";
import type { RealtimeHub } from "./hub.js";

declare module "fastify" {
  interface FastifyInstance {
    realtime: RealtimeHub;
  }
}

export {};
