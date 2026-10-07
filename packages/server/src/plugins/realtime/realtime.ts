import type { FastifyInstance } from "fastify";
import { getHealthRegistry } from "../../health/index.js";
import fp from "fastify-plugin";

export interface RealtimeServerPluginOptions extends Omit<import("@oneunit/realtime").RealtimeHubOptions, "heartbeat"> {
    routes?: (app: FastifyInstance) => Promise<void>;
    websocketLibrary?: "fastify" | "ws";
    path?: string;
    channel?: string;
    e2ee?: boolean;
    maxPayload?: number;
    heartbeat?: boolean;
    heartbeatInterval?: number;
    onConnection?: import("@oneunit/realtime").RealtimeConnectionHandler;
    onMessage?: import("@oneunit/realtime").RealtimeMessageHandler;
    attachConnections?: boolean;
}

declare module "fastify" {
    interface FastifyInstance {
        realtime: import("@oneunit/realtime").RealtimeHub;
    }
}

// WeakSet to track registered servers
const registeredServers = new WeakSet<FastifyInstance>();

async function realtimePlugin(
    server: FastifyInstance,
    options: RealtimeServerPluginOptions = {},
): Promise<void> {
    // Guard against double registration on the same server instance
    if (registeredServers.has(server)) {
        server.log.debug("realtime plugin already registered on this server, skipping");
        return;
    }

    let registerRealtime: (app: FastifyInstance, options: RealtimeServerPluginOptions) => Promise<import("@oneunit/realtime").RealtimeHub>;

    try {
        const realtimeModule = await import("@oneunit/realtime") as {
            registerRealtime: typeof registerRealtime;
        };
        registerRealtime = realtimeModule.registerRealtime;
    } catch (err) {
        server.log.warn({ err }, "realtime package not installed, realtime plugin disabled");
        return;
    }

    const { routes, ...realtimeOptions } = options;

    const hub = await registerRealtime(server, realtimeOptions);

    // Check if registerRealtime already decorated the server
    if (!server.hasDecorator("realtime")) {
        server.decorate("realtime", hub);
    }
    registeredServers.add(server);

    // Register health check
    const registry = getHealthRegistry(server);
    registry.register({
        name: "realtime",
        check: async () => {
            return { status: "healthy" as const };
        },
        critical: false,
    });

    if (routes) {
        await routes(server);
    }

    server.addHook("onClose", async () => {
        hub.close();
    });
}

export default fp(realtimePlugin);
export { realtimePlugin };