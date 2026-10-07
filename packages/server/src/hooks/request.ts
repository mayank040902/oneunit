import type {
    FastifyInstance,
    onRequestHookHandler,
    preParsingHookHandler,
    preValidationHookHandler,
    preHandlerHookHandler,
    preSerializationHookHandler,
    onSendHookHandler,
    onResponseHookHandler,
    onErrorHookHandler,
    onTimeoutHookHandler,
    onRequestAbortHookHandler,
} from "fastify";

export type HookList<T> = T | T[];

export interface RequestHooks {
    onRequest?: HookList<onRequestHookHandler>;
    preParsing?: HookList<preParsingHookHandler>;
    preValidation?: HookList<preValidationHookHandler>;
    preHandler?: HookList<preHandlerHookHandler>;
    preSerialization?: HookList<preSerializationHookHandler>;
    onSend?: HookList<onSendHookHandler>;
    onResponse?: HookList<onResponseHookHandler>;
    onError?: HookList<onErrorHookHandler>;
    onTimeout?: HookList<onTimeoutHookHandler>;
    onRequestAbort?: HookList<onRequestAbortHookHandler>;
}

function asArray<T>(value: HookList<T> | undefined): T[] {
    if (value === undefined) {
        return [];
    }

    return Array.isArray(value) ? value : [value];
}

export function registerRequestHooks(
    server: FastifyInstance,
    hooks: RequestHooks = {},
): void {
    for (const handler of asArray(hooks.onRequest)) {
        server.addHook("onRequest", handler);
    }
    for (const handler of asArray(hooks.preParsing)) {
        server.addHook("preParsing", handler);
    }
    for (const handler of asArray(hooks.preValidation)) {
        server.addHook("preValidation", handler);
    }
    for (const handler of asArray(hooks.preHandler)) {
        server.addHook("preHandler", handler);
    }
    for (const handler of asArray(hooks.preSerialization)) {
        server.addHook("preSerialization", handler);
    }
    for (const handler of asArray(hooks.onSend)) {
        server.addHook("onSend", handler);
    }
    for (const handler of asArray(hooks.onResponse)) {
        server.addHook("onResponse", handler);
    }
    for (const handler of asArray(hooks.onError)) {
        server.addHook("onError", handler);
    }
    for (const handler of asArray(hooks.onTimeout)) {
        server.addHook("onTimeout", handler);
    }
    for (const handler of asArray(hooks.onRequestAbort)) {
        server.addHook("onRequestAbort", handler);
    }
}