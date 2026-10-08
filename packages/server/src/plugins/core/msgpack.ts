import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import fp from "fastify-plugin";

export interface MsgpackPluginOptions {
  enableBuiltin?: boolean;
  extensions?: Array<{ type: number; encode: unknown; decode: unknown }>;
}

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
    (request, payload, done) => {
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
    (request, payload, done) => {
      try {
        const result = decoder.decode(payload as Buffer);
        done(null, result);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  if (enableBuiltin) {
    server.addHook("onSend", async (request, reply, payload) => {
      const accept = request.headers.accept || "";
      if (
        accept.includes("application/msgpack") ||
        accept.includes("application/x-msgpack")
      ) {
        reply.header("content-type", "application/msgpack");
        return encoder.encode(payload);
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
