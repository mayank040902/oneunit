import type { FastifyInstance } from "fastify";
import { registerRequestHooks, type RequestHooks, type HookList } from "./request.js";
import { registerServerHooks, type ServerHooks } from "./server.js";

export { registerRequestHooks, type RequestHooks } from "./request.js";
export { registerServerHooks, type ServerHooks } from "./server.js";

export type { HookList } from "./request.js";

export interface BootstrapHooks {
    onRequest?: HookList<import("fastify").onRequestHookHandler>;
    preParsing?: HookList<import("fastify").preParsingHookHandler>;
    preValidation?: HookList<import("fastify").preValidationHookHandler>;
    preHandler?: HookList<import("fastify").preHandlerHookHandler>;
    preSerialization?: HookList<import("fastify").preSerializationHookHandler>;
    onSend?: HookList<import("fastify").onSendHookHandler>;
    onResponse?: HookList<import("fastify").onResponseHookHandler>;
    onError?: HookList<import("fastify").onErrorHookHandler>;
    onTimeout?: HookList<import("fastify").onTimeoutHookHandler>;
    onRequestAbort?: HookList<import("fastify").onRequestAbortHookHandler>;
    onReady?: HookList<import("fastify").onReadyHookHandler>;
    onListen?: HookList<import("fastify").onListenHookHandler>;
    onClose?: HookList<import("fastify").onCloseHookHandler>;
    onRoute?: HookList<import("fastify").onRouteHookHandler>;
    onRegister?: HookList<import("fastify").onRegisterHookHandler>;
}

export function registerHooks(
    server: FastifyInstance,
    hooks: BootstrapHooks = {},
): void {
    registerRequestHooks(server, hooks as RequestHooks);
    registerServerHooks(server, hooks as ServerHooks);
}