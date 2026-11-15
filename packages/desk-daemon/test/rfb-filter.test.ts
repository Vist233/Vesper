import { describe, expect, it } from "vitest";
import { MAX_CUT_TEXT_BYTES, RFB_VERSION, RfbViewFilter } from "../src/rfb-filter.ts";

const version = Buffer.from(RFB_VERSION, "latin1");
const setPixelFormat = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.alloc(16, 7)]);
const setEncodings = (codes: number[]): Buffer => {
  const head = Buffer.from([2, 0, 0, 0]);
  head.writeUInt16BE(codes.length, 2);
  const body = Buffer.alloc(4 * codes.length);
  codes.forEach((code, i) => {
    body.writeInt32BE(code, 4 * i);
  });
  return Buffer.concat([head, body]);
};
const updateRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0x05, 0x00, 0x03, 0x20]);
const keyEvent = Buffer.from([4, 1, 0, 0, 0, 0, 0xff, 0x0d]);
const pointerEvent = Buffer.from([5, 1, 0x01, 0x00, 0x02, 0x00]);
const cutText = (text: string): Buffer => {
  const head = Buffer.from([6, 0, 0, 0, 0, 0, 0, 0]);
  head.writeUInt32BE(text.length, 4);
  return Buffer.concat([head, Buffer.from(text, "latin1")]);
};

/** A filter that has done the handshake. */
function ready(): RfbViewFilter {
  const filter = new RfbViewFilter();
  filter.push(Buffer.concat([version, Buffer.from([1, 0])]));
  return filter;
}

describe("RfbViewFilter handshake", () => {
  it("forwards version and the None security type, and rewrites ClientInit to shared", () => {
    const filter = new RfbViewFilter();
    const result = filter.push(Buffer.concat([version, Buffer.from([1]), Buffer.from([0])]));
    expect(result.violation).toBeUndefined();
    expect([...result.forward]).toEqual([...version, 1, 1]);
  });

  it("works when the handshake arrives one byte at a time", () => {
    const filter = new RfbViewFilter();
    const sent = Buffer.concat([version, Buffer.from([1, 0])]);
    const forwarded: number[] = [];
    for (const byte of sent) {
      const result = filter.push(Buffer.from([byte]));
      expect(result.violation).toBeUndefined();
      forwarded.push(...result.forward);
    }
    expect(forwarded).toEqual([...version, 1, 1]);
  });

  it("refuses any other version", () => {
    for (const other of ["RFB 003.003\n", "RFB 003.007\n", "RFB 003.889\n", "GET / HTTP/1.\n"]) {
      const result = new RfbViewFilter().push(Buffer.from(other, "latin1"));
      expect(result.violation).toMatch(/version/);
      expect(result.forward.length).toBe(0);
    }
  });

  it("refuses any security type but 1 and forwards nothing of it", () => {
    for (const type of [0, 2, 16, 255]) {
      const result = new RfbViewFilter().push(Buffer.concat([version, Buffer.from([type])]));
      expect(result.violation).toMatch(/security type/);
      expect([...result.forward]).toEqual([...version]);
    }
  });

  it("stays failed after a violation", () => {
    const filter = new RfbViewFilter();
    expect(filter.push(Buffer.from("nonsense----", "latin1")).violation).toBeDefined();
    const after = filter.push(Buffer.concat([version, Buffer.from([1, 0])]));
    expect(after.forward.length).toBe(0);
  });
});

describe("RfbViewFilter messages", () => {
  it("forwards SetPixelFormat, SetEncodings and FramebufferUpdateRequest unchanged", () => {
    const filter = ready();
    const stream = Buffer.concat([setPixelFormat, setEncodings([0, 1, -223, 7]), updateRequest]);
    const result = filter.push(stream);
    expect(result.violation).toBeUndefined();
    expect(result.forward.equals(stream)).toBe(true);
  });

  it("drops key events, pointer events and cut text and keeps what is around them", () => {
    const filter = ready();
    const stream = Buffer.concat([updateRequest, keyEvent, pointerEvent, cutText("secret"), keyEvent, updateRequest]);
    const result = filter.push(stream);
    expect(result.violation).toBeUndefined();
    expect(result.forward.equals(Buffer.concat([updateRequest, updateRequest]))).toBe(true);
  });

  it("handles messages split at every byte boundary", () => {
    const stream = Buffer.concat([setEncodings([0, 1]), keyEvent, cutText("hello"), pointerEvent, updateRequest]);
    for (let cut = 1; cut < stream.length; cut += 1) {
      const filter = ready();
      const first = filter.push(stream.subarray(0, cut));
      const second = filter.push(stream.subarray(cut));
      expect(first.violation ?? second.violation).toBeUndefined();
      expect(Buffer.concat([first.forward, second.forward]).equals(Buffer.concat([setEncodings([0, 1]), updateRequest]))).toBe(true);
    }
  });

  it("accepts cut text of exactly the limit and refuses one byte more, before the text arrives", () => {
    const filter = ready();
    const head = Buffer.from([6, 0, 0, 0, 0, 0, 0, 0]);
    head.writeUInt32BE(MAX_CUT_TEXT_BYTES, 4);
    expect(filter.push(head).violation).toBeUndefined();
    const over = Buffer.from([6, 0, 0, 0, 0, 0, 0, 0]);
    over.writeUInt32BE(MAX_CUT_TEXT_BYTES + 1, 4);
    const result = ready().push(over);
    expect(result.violation).toMatch(/type 6/);
  });

  it("drops the Extended Clipboard form of cut text (negative length) that noVNC 1.7 sends first, however the bytes are split", () => {
    const head = Buffer.from([6, 0, 0, 0, 0, 0, 0, 0]);
    head.writeInt32BE(-8, 4);
    const message = Buffer.concat([head, Buffer.alloc(8, 1)]);
    const stream = Buffer.concat([updateRequest, message, keyEvent, updateRequest]);
    for (let cut = 1; cut < stream.length; cut += 1) {
      const filter = ready();
      const first = filter.push(stream.subarray(0, cut));
      const second = filter.push(stream.subarray(cut));
      expect(first.violation ?? second.violation).toBeUndefined();
      expect(Buffer.concat([first.forward, second.forward]).equals(Buffer.concat([updateRequest, updateRequest]))).toBe(true);
    }
  });

  it("refuses an Extended Clipboard message whose absolute length is over the limit", () => {
    const head = Buffer.from([6, 0, 0, 0, 0, 0, 0, 0]);
    head.writeInt32BE(-(MAX_CUT_TEXT_BYTES + 1), 4);
    expect(ready().push(head).violation).toMatch(/type 6/);
  });

  it("reports the type number of an unknown message and forwards nothing after it", () => {
    const result = ready().push(Buffer.concat([updateRequest, Buffer.from([7, 0, 0, 0]), updateRequest]));
    expect(result.violation).toBe("message type 7 is not allowed from a view-only client");
    expect(result.forward.equals(updateRequest)).toBe(true);
  });

  it("refuses the extension messages a viewer should not send (150 continuous updates, 248 fence)", () => {
    expect(ready().push(Buffer.from([150, 1, 0, 0, 0, 0, 0, 0, 0, 0])).violation).toMatch(/type 150/);
    expect(ready().push(Buffer.from([248, 0, 0, 0, 0, 0, 0, 0, 0])).violation).toMatch(/type 248/);
  });
});
