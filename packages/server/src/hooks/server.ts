import type {
    FastifyInstance,
    onReadyHookHandler,
    onListenHookHandler,
    onCloseHookHandler,
    onRouteHookHandler,
    onRegisterHookHandler,
} from "fastify";

export type HookList<T> = T | T[];

export interface ServerHooks {
    onReady?: HookList<onReadyHookHandler>;
    onListen?: HookList<onListenHookHandler>;
    onClose?: HookList<onCloseHookHandler>;
    onRoute?: HookList<onRouteHookHandler>;
    onRegister?: HookList<onRegisterHookHandler>;
}

function asArray<T>(value: HookList<T> | undefined): T[] {
    if (value === undefined) {
        return [];
    }

    return Array.isArray(value) ? value : [value];
}

export function registerServerHooks(
    server: FastifyInstance,
    hooks: ServerHooks = {},
): void {
    for (const handler of asArray(hooks.onReady)) {
        server.addHook("onReady", handler);
    }
    for (const handler of asArray(hooks.onListen)) {
        server.addHook("onListen", handler);
    }
    for (const handler of asArray(hooks.onClose)) {
        server.addHook("onClose", handler);
    }
    for (const handler of asArray(hooks.onRoute)) {
        server.addHook("onRoute", handler);
    }
    for (const handler of asArray(hooks.onRegister)) {
        server.addHook("onRegister", handler);
    }
}