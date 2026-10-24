import type { Auth } from "../core/auth.js";

import { expressAdapter } from "./express/index.js";
import { fastifyAdapter } from "./fastify/index.js";
import { koaAdapter } from "./koa/index.js";
import { uwsAdapter, snapshotUwsRequest } from "./uws/index.js";

export { expressAdapter, fastifyAdapter, koaAdapter, uwsAdapter, snapshotUwsRequest };

export function createAdapters(auth: Auth) {
  return {
    express: expressAdapter(auth),
    fastify: fastifyAdapter(auth),
    koa: koaAdapter(auth),
    uws: uwsAdapter(auth),
    uWebSockets: uwsAdapter(auth),
  };
}
