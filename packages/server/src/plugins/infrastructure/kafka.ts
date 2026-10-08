import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { getHealthRegistry, createKafkaHealthProvider } from "../../health/index.js";

export interface KafkaPluginOptions {
    brokers?: string | string[];
    clientId?: string;
    groupId?: string;
    ssl?: boolean | object;
    sasl?: boolean | object;
    retry?: object;
    logLevel?: string;
    partitioner?: string;
    autoConnectProducer?: boolean;
    consumerGroupId?: string;
    subscribeTopics?: string | string[];
    onMessage?: (payload: { topic: string; partition: number; key: unknown; value: unknown }) => Promise<void>;
    producer?: object;
    consumer?: object;
    admin?: object;
    codec?: "json" | "avro" | "protobuf";
    parseJson?: boolean;
    fromBeginning?: boolean;
}

declare module "fastify" {
    interface FastifyInstance {
        kafka: {
            getProducer: (options?: object) => Promise<unknown>;
            getConsumer: (groupIdOrOptions?: string | object, options?: object) => Promise<unknown>;
            getAdmin: (options?: object) => Promise<unknown>;
            subscribe: (topic: string, options?: object) => Promise<unknown>;
            consume: (topicOrHandler: string | ((payload: { topic: string; partition: number; key: unknown; value: unknown }) => Promise<void>), handlerOrOptions?: ((payload: { topic: string; partition: number; key: unknown; value: unknown }) => Promise<void>) | object, options?: object) => Promise<unknown>;
            send: (topic: string, messages: unknown | unknown[], options?: object) => Promise<unknown>;
            disconnect: () => Promise<void>;
            registerShutdown: (extra?: { producer?: unknown; consumer?: unknown; admin?: unknown; clients?: Array<{ disconnect(): Promise<void> }>; exit?: boolean }) => (signal: string) => Promise<void>;
            [key: string]: unknown;
        };
    }
}

async function kafkaPlugin(
    server: FastifyInstance,
    options: KafkaPluginOptions = {},
): Promise<void> {
    let createKafkaClient: (loggerOrOptions: unknown, maybeOptions?: Record<string, unknown>) => {
        getProducer: (options?: object) => Promise<unknown>;
        getConsumer: (groupIdOrOptions?: string | object, options?: object) => Promise<unknown>;
        getAdmin: (options?: object) => Promise<unknown>;
        subscribe: (topic: string, options?: object) => Promise<unknown>;
        consume: (topicOrHandler: string | ((payload: { topic: string; partition: number; key: unknown; value: unknown }) => Promise<void>), handlerOrOptions?: ((payload: { topic: string; partition: number; key: unknown; value: unknown }) => Promise<void>) | object, options?: object) => Promise<unknown>;
        send: (topic: string, messages: unknown | unknown[], options?: object) => Promise<unknown>;
        disconnect: () => Promise<void>;
        registerShutdown: (extra?: { producer?: unknown; consumer?: unknown; admin?: unknown; clients?: Array<{ disconnect(): Promise<void> }>; exit?: boolean }) => (signal: string) => Promise<void>;
    };

    try {
        const kafkaModule = await import("@oneunit/kafka") as {
            createKafkaClient: typeof createKafkaClient;
        };
        createKafkaClient = kafkaModule.createKafkaClient;
    } catch (err) {
        server.log?.warn?.({ err }, "kafka package not installed, skipping kafka plugin");
        return;
    }

    const {
        brokers,
        autoConnectProducer = false,
        consumerGroupId,
        subscribeTopics,
        onMessage,
        ...clientOptions
    } = options;

    // Only create Kafka client if brokers are configured
    if (!brokers) {
        server.log.info("Kafka brokers not configured, kafka plugin disabled");
        return;
    }

    const client = createKafkaClient(server.log, { ...clientOptions, brokers });

    server.decorate("kafka", client);

    if (autoConnectProducer) {
        await client.getProducer();
    }

    if (consumerGroupId && subscribeTopics) {
        const topics = Array.isArray(subscribeTopics) ? subscribeTopics : [subscribeTopics];
        await client.getConsumer(consumerGroupId);

        for (const topic of topics) {
            await client.subscribe(topic);
        }

        if (onMessage) {
            await client.consume(topics[0], onMessage);
        }
    }

    // Register health check
    const registry = getHealthRegistry(server);
    registry.register(createKafkaHealthProvider(
        async () => {
            // Kafka health check - try to get metadata or list topics
            const producer = await client.getProducer();
            // If we can get a producer, the connection is healthy
            return;
        },
        false, // Kafka is not critical by default
    ));

    server.addHook("onClose", async () => {
        await client.disconnect();
    });
}

export default fp(kafkaPlugin, {
    name: "kafka",
    fastify: "5.x",
});
export { kafkaPlugin };