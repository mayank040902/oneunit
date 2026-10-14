import { describe, it, expect } from 'vitest';
import { TcpFrameParser, encodeTcpFrame } from '../../src/adapters/network/tcp/frame-parser.js';

describe('TCP Framing - Hardcore Adversarial', () => {
  it('should handle partial frames correctly', () => {
    const data = Buffer.from('hello world');
    const serialized = encodeTcpFrame(data);
    const parser = new TcpFrameParser({ maxFrameSize: 65536 });
    const r1 = parser.feed(serialized.slice(0, 2));
    expect(r1.frames.length).toBe(0);
    const r2 = parser.feed(serialized.slice(2));
    expect(r2.frames[0]).toEqual(data);
  });
  
  it('should reject oversized frames', () => {
    const parser = new TcpFrameParser({ maxFrameSize: 1024 });
    const large = Buffer.alloc(2048, 'a');
    const encoded = encodeTcpFrame(large);
    const result = parser.feed(encoded);
    expect(result.error).not.toBeNull();
  });
  
  it('should handle empty buffer parsing', () => {
    const parser = new TcpFrameParser({ maxFrameSize: 65536 });
    const result = parser.feed(Buffer.alloc(0));
    expect(result.frames.length).toBe(0);
  });
  
  it('should handle incomplete header', () => {
    const parser = new TcpFrameParser({ maxFrameSize: 65536 });
    const result = parser.feed(Buffer.from([0, 0]));
    expect(result.frames.length).toBe(0);
  });
  
  it('should handle multiple frames in buffer', () => {
    const frame1 = Buffer.from('hello');
    const frame2 = Buffer.from('world');
    const buf = Buffer.concat([encodeTcpFrame(frame1), encodeTcpFrame(frame2)]);
    const parser = new TcpFrameParser({ maxFrameSize: 65536 });
    const result = parser.feed(buf);
    expect(result.frames.length).toBe(2);
    expect(result.frames[0]).toEqual(frame1);
    expect(result.frames[1]).toEqual(frame2);
  });
});
