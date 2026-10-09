import { describe, it, expect } from 'vitest';
import { TcpFrameParser, encodeTcpFrame } from '../../src/adapters/network/tcp/frame-parser.js';

function makeFrame(payload: Buffer | Uint8Array): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, Buffer.from(payload)]);
}

describe('encodeTcpFrame', () => {
  it('prepends a 4-byte big-endian length header', () => {
    const payload = Buffer.from('hello');
    const frame = encodeTcpFrame(payload);

    expect(frame.length).toBe(4 + 5);
    expect(frame.readUInt32BE(0)).toBe(5);
    expect(frame.slice(4)).toEqual(payload);
  });

  it('supports empty payloads', () => {
    const frame = encodeTcpFrame(Buffer.alloc(0));
    expect(frame.length).toBe(4);
    expect(frame.readUInt32BE(0)).toBe(0);
  });

  it('supports Uint8Array input', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const frame = encodeTcpFrame(payload);
    expect(frame.readUInt32BE(0)).toBe(3);
    expect(frame.slice(4)).toEqual(Buffer.from([1, 2, 3]));
  });
});

describe('TcpFrameParser', () => {
  it('emits a complete frame when the full payload arrives in one chunk', () => {
    const parser = new TcpFrameParser({ maxFrameSize: 1024 });
    const frame = makeFrame(Buffer.from('hello world'));

    const result = parser.feed(frame);

    expect(result.error).toBeNull();
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toEqual(Buffer.from('hello world'));
  });

  it('emits multiple frames when several arrive in one chunk', () => {
    const parser = new TcpFrameParser({ maxFrameSize: 1024 });
    const chunk = Buffer.concat([
      makeFrame(Buffer.from('a')),
      makeFrame(Buffer.from('bb')),
      makeFrame(Buffer.from('ccc')),
    ]);

    const result = parser.feed(chunk);

    expect(result.error).toBeNull();
    expect(result.frames).toEqual([
      Buffer.from('a'),
      Buffer.from('bb'),
      Buffer.from('ccc'),
    ]);
  });

  it('buffers a partial header and emits nothing until it is complete', () => {
    const parser = new TcpFrameParser({ maxFrameSize: 1024 });
    const frame = makeFrame(Buffer.from('hello world'));

    // Feed only the first 2 bytes of the header.
    const first = parser.feed(frame.subarray(0, 2));
    expect(first.frames).toHaveLength(0);
    expect(first.error).toBeNull();
    expect(parser.bufferedBytes).toBe(2);

    // Feed the remainder.
    const second = parser.feed(frame.subarray(2));
    expect(second.frames).toEqual([Buffer.from('hello world')]);
    expect(second.error).toBeNull();
    expect(parser.bufferedBytes).toBe(0);
  });

  it('buffers a partial payload and emits the frame once complete', () => {
    const parser = new TcpFrameParser({ maxFrameSize: 1024 });
    const frame = makeFrame(Buffer.from('hello world'));

    // Feed header plus part of the payload.
    const partial = frame.subarray(0, 7);
    const first = parser.feed(partial);
    expect(first.frames).toHaveLength(0);
    expect(first.error).toBeNull();

    // Feed the rest of the payload.
    const second = parser.feed(frame.subarray(7));
    expect(second.frames).toEqual([Buffer.from('hello world')]);
    expect(parser.bufferedBytes).toBe(0);
  });

  it('emits multiple frames across chunk boundaries', () => {
    const parser = new TcpFrameParser({ maxFrameSize: 1024 });
    const frame1 = makeFrame(Buffer.from('first'));
    const frame2 = makeFrame(Buffer.from('second'));

    // Feed a split in the middle of the second frame.
    const first = parser.feed(Buffer.concat([frame1, frame2.subarray(0, 3)]));
    expect(first.frames).toEqual([Buffer.from('first')]);
    expect(first.error).toBeNull();

    const second = parser.feed(frame2.subarray(3));
    expect(second.frames).toEqual([Buffer.from('second')]);
  });

  it('rejects frames larger than maxFrameSize and stops parsing', () => {
    const parser = new TcpFrameParser({ maxFrameSize: 10 });

    // Craft a header claiming a 100-byte payload.
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(100, 0);
    const result = parser.feed(oversized);

    expect(result.error).not.toBeNull();
    expect(result.error!.message).toContain('exceeds maximum');
    expect(result.frames).toHaveLength(0);
  });

  it('does not consume subsequent frames after an oversized frame', () => {
    const parser = new TcpFrameParser({ maxFrameSize: 10 });

    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(100, 0);
    const valid = makeFrame(Buffer.from('ok'));

    const result = parser.feed(Buffer.concat([oversized, valid]));

    expect(result.error).not.toBeNull();
    expect(result.frames).toHaveLength(0);
    // The parser stops at the oversized frame without consuming any bytes,
    // so the entire chunk remains buffered for the caller to inspect or reset.
    expect(parser.bufferedBytes).toBe(oversized.length + valid.length);
  });

  it('supports a zero-length frame', () => {
    const parser = new TcpFrameParser({ maxFrameSize: 1024 });
    const result = parser.feed(makeFrame(Buffer.alloc(0)));

    expect(result.error).toBeNull();
    expect(result.frames).toEqual([Buffer.alloc(0)]);
  });

  it('reset discards buffered partial data', () => {
    const parser = new TcpFrameParser({ maxFrameSize: 1024 });
    const frame = makeFrame(Buffer.from('hello world'));

    parser.feed(frame.subarray(0, 3));
    expect(parser.bufferedBytes).toBe(3);

    parser.reset();
    expect(parser.bufferedBytes).toBe(0);
  });
});