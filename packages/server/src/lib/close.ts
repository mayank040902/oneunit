import type { FastifyInstance } from "fastify";

/**
 * Default time the server waits for the drain to finish before it drops the
 * remaining sockets.
 */
export const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;

/** How often the drain re-checks for sockets that went idle. */
const IDLE_POLL_INTERVAL_MS = 25;

export interface BoundedCloseOptions {
    /** Time to wait for the drain before the sockets are dropped. */
    timeoutMs?: number;
    /** How often to look for sockets that have gone idle. */
    pollIntervalMs?: number;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

/**
 * Waits for the server to close, making sure it actually finishes.
 *
 * `server.close()` stops the listener, but Node keeps every socket that was
 * active at that moment. A client on a keep-alive connection that goes idle
 * afterwards keeps that socket — and therefore the close — alive indefinitely:
 * `await app.close()` never returns, and a graceful shutdown has to be
 * killed rather than finished.
 *
 * Two mechanisms close that gap:
 *
 * - idle sockets are closed repeatedly while the drain runs, so a connection
 *   that finishes a request during the shutdown is released as soon as it goes
 *   idle;
 * - the deadline is the backstop for a socket that never goes idle. The
 *   remaining connections are then dropped, which aborts the requests that
 *   were still running.
 */
export async function drainAndClose(
    app: FastifyInstance,
    closing: Promise<unknown>,
    options: BoundedCloseOptions = {},
): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? IDLE_POLL_INTERVAL_MS;

    const poller = setInterval(() => {
        app.server.closeIdleConnections?.();
    }, pollIntervalMs);
    poller.unref?.();

    const deadline = setTimeout(() => {
        app.server.closeAllConnections?.();
    }, timeoutMs);
    deadline.unref?.();

    try {
        await closing;
    } finally {
        clearInterval(poller);
        clearTimeout(deadline);
    }
}

/**
 * Replaces `app.close()` with a version that always terminates.
 *
 * The callback and promise forms of the Fastify API are both preserved.
 */
export function installBoundedClose(
    app: FastifyInstance,
    options: BoundedCloseOptions = {},
): void {
    const originalClose = app.close.bind(app);

    const close = (listener?: () => void): Promise<void> | undefined => {
        const closing = originalClose() as Promise<unknown>;
        const drained = drainAndClose(app, closing, options);

        if (listener) {
            void drained.then(
                () => listener(),
                () => listener(),
            );
            return undefined;
        }

        return drained;
    };

    app.close = close as FastifyInstance["close"];
}

/**
 * Closes a server that was not created through the bootstrap.
 *
 * Used when the instance is owned by the caller and the bounded close was not
 * installed, so a shutdown still cannot hang.
 */
export async function closeWithDeadline(
    app: FastifyInstance,
    options: BoundedCloseOptions = {},
): Promise<void> {
    const originalClose = app.close.bind(app);
    const closing = originalClose() as Promise<unknown>;
    await drainAndClose(app, closing, options);
    // Give the underlying close a moment to settle once the sockets are gone.
    await sleep(0);
}
