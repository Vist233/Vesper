import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createSseParser } from "../src/sse.js";

function parse(chunks: string[]) {
  const frames: any[] = [];
  const retries: number[] = [];
  const parser = createSseParser((f) => frames.push(f), { onRetry: (ms) => retries.push(ms) });
  for (const chunk of chunks) parser.feed(chunk);
  return { frames, retries };
}

describe("event-stream parser", () => {
  it("reads id and data", () => {
    expect(parse(['id: 7\ndata: {"a":1}\n\n']).frames).toEqual([{ id: "7", event: "message", data: '{"a":1}' }]);
  });
  it("joins multi-line data, keeps the id across frames, reads event names", () => {
    const { frames } = parse(["id: 1\ndata: a\ndata: b\n\nevent: x\ndata: c\n\n"]);
    expect(frames).toEqual([
      { id: "1", event: "message", data: "a\nb" },
      { id: "1", event: "x", data: "c" },
    ]);
  });
  it("ignores comments, heartbeats, retry and frames without data, and reports retry", () => {
    const { frames, retries } = parse(["retry: 2000\n\n: ping\n\nid: 3\n\nid: 4\ndata: z\n\n"]);
    expect(frames).toEqual([{ id: "4", event: "message", data: "z" }]);
    expect(retries).toEqual([2000]);
  });
  it("accepts CRLF and CR line ends, even when the pair is split between pieces", () => {
    expect(parse(["id: 1\r\ndata: a\r\n\r\n"]).frames).toHaveLength(1);
    expect(parse(["id: 1\rdata: a\r\r"]).frames).toHaveLength(1);
    expect(parse(["id: 1\r", "\ndata: a\r", "\n\r", "\n"]).frames).toEqual([{ id: "1", event: "message", data: "a" }]);
  });
  it("a value without a space after the colon and a field without a colon", () => {
    expect(parse(["data:x\n\ndata\n\n"]).frames).toEqual([
      { id: undefined, event: "message", data: "x" },
      { id: undefined, event: "message", data: "" },
    ]);
  });

  it("gives the same frames however the bytes are cut into pieces (500 runs)", () => {
    const stream = fc
      .array(fc.record({ id: fc.nat(1000), data: fc.string({ maxLength: 20 }).filter((s) => !/[\r\n]/.test(s)) }), { maxLength: 12 })
      .map((frames) => ({
        frames,
        text: `retry: 2000\n\n${frames.map((f) => `id: ${f.id}\ndata: ${f.data}\n\n: ping\n\n`).join("")}`,
      }));
    fc.assert(
      fc.property(stream, fc.array(fc.nat(30), { maxLength: 20 }), ({ frames, text }, cuts) => {
        const pieces: string[] = [];
        let position = 0;
        for (const cut of cuts) {
          const end = Math.min(text.length, position + cut);
          pieces.push(text.slice(position, end));
          position = end;
        }
        pieces.push(text.slice(position));
        const { frames: got } = parse(pieces);
        const expected = frames.filter((f) => f.data !== "" || true).map((f) => ({ id: String(f.id), event: "message", data: f.data }));
        // a frame whose data is the empty string still has a data line, so it is a frame
        expect(got).toEqual(expected);
      }),
      { numRuns: 500 },
    );
  });
});
