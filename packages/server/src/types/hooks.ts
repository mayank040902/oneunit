import type {
    onCloseHookHandler,
    onErrorHookHandler,
    onListenHookHandler,
    onReadyHookHandler,
    onRegisterHookHandler,
    onRequestAbortHookHandler,
    onRequestHookHandler,
    onResponseHookHandler,
    onRouteHookHandler,
    onSendHookHandler,
    onTimeoutHookHandler,
    preHandlerHookHandler,
    preParsingHookHandler,
    preSerializationHookHandler,
    preValidationHookHandler,
} from "fastify";

export type HookList<T> = T | T[];

export interface BootstrapHooks {
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
    onReady?: HookList<onReadyHookHandler>;
    onListen?: HookList<onListenHookHandler>;
    onClose?: HookList<onCloseHookHandler>;
    onRoute?: HookList<onRouteHookHandler>;
    onRegister?: HookList<onRegisterHookHandler>;
}