import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeFrame, FrameParser } from "../src/ws-frame.ts";

describe("FrameParser", () => {
  function maskedFrame(opcode: number, payload: Buffer, fin = true): Buffer {
    const mask = Buffer.from([1, 2, 3, 4]);
    const body = Buffer.from(payload.map((b, i) => b ^ (mask[i % 4] as number)));
    const length = payload.length < 126 ? Buffer.from([0x80 | payload.length]) : Buffer.from([0x80 | 126, payload.length >> 8, payload.length & 255]);
    return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode]), length, mask, body]);
  }
  function recorder() {
    const events: string[] = [];
    const parser = new FrameParser({
      binary: (p) => events.push(`binary:${p.toString()}`),
      ping: (p) => events.push(`ping:${p.toString()}`),
      close: () => events.push("close"),
      protocolError: () => events.push("error"),
    });
    return { events, parser };
  }

  it("reads frames split across chunks and several frames in one chunk", () => {
    const { events, parser } = recorder();
    const all = Buffer.concat([maskedFrame(2, Buffer.from("ab")), maskedFrame(2, Buffer.from("cd"))]);
    parser.push(all.subarray(0, 3));
    parser.push(all.subarray(3));
    expect(events).toEqual(["binary:ab", "binary:cd"]);
  });

  it("handles ping, pong, continuation and close", () => {
    const { events, parser } = recorder();
    parser.push(maskedFrame(9, Buffer.from("hi")));
    parser.push(maskedFrame(0xa, Buffer.alloc(0)));
    parser.push(maskedFrame(2, Buffer.from("x"), false));
    parser.push(maskedFrame(0, Buffer.from("y")));
    parser.push(maskedFrame(8, Buffer.alloc(0)));
    parser.push(maskedFrame(2, Buffer.from("ignored")));
    expect(events).toEqual(["ping:hi", "binary:x", "binary:y", "close"]);
  });

  it("fails on an unmasked frame, a text frame, and an oversized length", () => {
    for (const bad of [
      Buffer.from([0x82, 0x01, 0x41]),
      maskedFrame(1, Buffer.from("t")),
      Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]),
    ]) {
      const { events, parser } = recorder();
      parser.push(bad);
      expect(events).toEqual(["error"]);
    }
  });

  it("accepts a frame of exactly 1 MiB and fails one byte more", () => {
    const frame = (length: number): Buffer => {
      const header = Buffer.alloc(14);
      header[0] = 0x82;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
      return Buffer.concat([header, Buffer.alloc(length)]);
    };
    const exact = recorder();
    exact.parser.push(frame(1024 * 1024));
    expect(exact.events.length).toBe(1);
    expect(exact.events[0]?.startsWith("binary:")).toBe(true);
    const over = recorder();
    over.parser.push(frame(1024 * 1024 + 1));
    expect(over.events).toEqual(["error"]);
  });

  it("encodes the three length forms", () => {
    expect(encodeFrame(2, Buffer.alloc(5)).length).toBe(7);
    expect(encodeFrame(2, Buffer.alloc(300)).length).toBe(304);
    expect(encodeFrame(2, Buffer.alloc(70_000)).length).toBe(70_010);
  });

  it("matches the RFC 6455 example accept key", () => {
    const accept = createHash("sha1").update("dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    expect(accept).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });
});
