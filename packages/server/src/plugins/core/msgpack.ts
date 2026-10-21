import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

export interface MsgpackPluginOptions {
  enableBuiltin?: boolean;
  extensions?: Array<{ type: number; encode: unknown; decode: unknown }>;
}

/** Holds the document that is about to be serialized for a reply. */
const RAW_PAYLOAD = Symbol("oneunit.msgpack.rawPayload");

async function msgpackPlugin(
  server: FastifyInstance,
  options: MsgpackPluginOptions = {},
): Promise<void> {
  const { enableBuiltin = true, extensions = [] } = options;

  let msgpack: {
    encode: (data: unknown) => Uint8Array;
    decode: (data: Uint8Array | Buffer) => unknown;
    Encoder: new (opts: Record<string, unknown>) => { encode: (data: unknown) => Uint8Array };
    Decoder: new (opts: Record<string, unknown>) => { decode: (data: Uint8Array | Buffer) => unknown };
    ExtensionCodec: new () => { register: (ext: Record<string, unknown>) => void };
  };

  try {
    msgpack = await import("@msgpack/msgpack") as unknown as typeof msgpack;
  } catch {
    server.log?.warn?.("msgpack package not installed, skipping msgpack plugin");
    return;
  }

  const codec = new msgpack.ExtensionCodec();
  for (const ext of extensions) {
    codec.register({
      type: ext.type,
      encode: ext.encode as (input: unknown, context: unknown) => Uint8Array | ((dataPos: number) => Uint8Array) | null,
      decode: ext.decode as (data: Uint8Array, extensionType: number, context: unknown) => unknown,
    });
  }

  const encoder = new msgpack.Encoder({ extensionCodec: codec, context: undefined });
  const decoder = new msgpack.Decoder({ extensionCodec: codec, context: undefined });

  server.addContentTypeParser(
    "application/msgpack",
    { parseAs: "buffer" },
    (_request, payload, done) => {
      try {
        const result = decoder.decode(payload as Buffer);
        done(null, result);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  server.addContentTypeParser(
    "application/x-msgpack",
    { parseAs: "buffer" },
    (_request, payload, done) => {
      try {
        const result = decoder.decode(payload as Buffer);
        done(null, result);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

    if (enableBuiltin) {
        // `onSend` only sees the serialized payload, which is the JSON text.
        // The document itself is kept here so the encoder receives the object
        // and not its text representation.
        server.addHook("preSerialization", async (_request, reply, payload) => {
            (reply as unknown as Record<symbol, unknown>)[RAW_PAYLOAD] = payload;
            return payload;
        });

        server.addHook("onSend", async (request, reply, payload) => {
        // A request can send more than one Accept header, in which case Node
        // hands them over as an array.
        const acceptHeader = request.headers.accept;
        const accept = Array.isArray(acceptHeader) ? acceptHeader.join(",") : (acceptHeader ?? "");
        if (
          accept.includes("application/msgpack") ||
          accept.includes("application/x-msgpack")
        ) {
          if (payload === undefined || payload === null) {
            return payload;
          }

          const raw = (reply as unknown as Record<symbol, unknown>)[RAW_PAYLOAD];
          const document = raw !== undefined ? raw : payload;

          reply.header("content-type", "application/msgpack");
          // Fastify only accepts a string or a Buffer as the final payload.
          return Buffer.from(encoder.encode(document));
        }
        return payload;
      });
    }

  server.decorate("msgpack", {
    encode: (data: unknown) => encoder.encode(data),
    decode: (data: Buffer) => decoder.decode(data),
    encoder,
    decoder,
    codec,
  });
}

export default fp(msgpackPlugin, {
  name: "msgpack",
  fastify: "5.x",
});
export { msgpackPlugin };
