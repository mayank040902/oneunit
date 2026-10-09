/**
 * TCP length-prefixed frame parser.
 *
 * Frame layout:
 *   ┌──────────────────────────┬────────────────────────────┐
 *   │ 4-byte unsigned length   │ Serialized message payload │
 *   │ Big-endian               │ Exactly length bytes       │
 *   └──────────────────────────┴────────────────────────────┘
 *
 * The parser is a stateful byte-stream consumer. It accumulates bytes
 * from an ordered TCP stream and emits complete frames as they become
 * available. It is deliberately decoupled from any specific socket so it
 * can be unit-tested against raw byte sequences.
 */

export interface TcpFrameParserOptions {
  maxFrameSize: number;
}

export interface TcpFrameFeedResult {
  frames: Buffer[];
  error: Error | null;
}

export class TcpFrameParser {
  private buffer: Buffer;
  private readonly maxFrameSize: number;

  constructor(options: TcpFrameParserOptions) {
    this.buffer = Buffer.alloc(0);
    this.maxFrameSize = options.maxFrameSize;
  }

  /** Append a chunk of bytes from the stream and return any complete frames. */
  feed(chunk: Buffer | Uint8Array): TcpFrameFeedResult {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const frames: Buffer[] = [];
    let error: Error | null = null;

    while (this.buffer.length >= 4) {
      const frameLength = this.buffer.readUInt32BE(0);

      if (frameLength > this.maxFrameSize) {
        error = new Error(
          `Frame size ${frameLength} exceeds maximum ${this.maxFrameSize}`,
        );
        break;
      }

      if (this.buffer.length >= 4 + frameLength) {
        const frame = this.buffer.slice(4, 4 + frameLength);
        this.buffer = this.buffer.slice(4 + frameLength);
        frames.push(frame);
      } else {
        // Partial payload; wait for more bytes.
        break;
      }
    }

    return { frames, error };
  }

  /** Number of bytes currently held in the internal buffer awaiting a full frame. */
  get bufferedBytes(): number {
    return this.buffer.length;
  }

  /** Discard any buffered partial data. */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}

/**
 * Encode a single payload as a length-prefixed TCP frame.
 */
export function encodeTcpFrame(data: Buffer | Uint8Array): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);
  return Buffer.concat([header, Buffer.from(data)]);
}