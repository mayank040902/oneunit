import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import {
  encode,
  decode,
  Encoder,
  Decoder,
  ExtensionCodec,
  type EncoderOptions,
  type DecoderOptions,
  type ExtensionCodecType,
} from "@msgpack/msgpack";

export interface MsgpackPluginOptions {
  enableBuiltin?: boolean;
  extensions?: Array<{ type: number; encode: unknown; decode: unknown }>;
}

function createExtensionCodec(
  extensions?: Array<{ type: number; encode: unknown; decode: unknown }>,
): ExtensionCodec<unknown> {
  const codec = new ExtensionCodec<unknown>();
  if (extensions) {
    for (const ext of extensions) {
      codec.register({
        type: ext.type,
        encode: ext.encode as (input: unknown, context: unknown) => Uint8Array | ((dataPos: number) => Uint8Array) | null,
        decode: ext.decode as (data: Uint8Array, extensionType: number, context: unknown) => unknown,
      });
    }
  }
  return codec;
}

async function msgpackPlugin(
  server: FastifyInstance,
  options: MsgpackPluginOptions = {},
): Promise<void> {
  const { enableBuiltin = true, extensions = [] } = options;

  const codec = createExtensionCodec(extensions);

  const encoder = new Encoder({ extensionCodec: codec, context: undefined });
  const decoder = new Decoder({ extensionCodec: codec, context: undefined });

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

export default msgpackPlugin;
export { msgpackPlugin, encode, decode, Encoder, Decoder, ExtensionCodec };