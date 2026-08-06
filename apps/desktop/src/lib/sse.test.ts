import { describe, expect, it } from "vitest";
import { createSseParser } from "./sse";

const FRAME = 'event: token\ndata: {"delta": "Hi"}\n\n';

describe("createSseParser", () => {
  it("parses a complete frame", () => {
    const parse = createSseParser();
    expect(parse(FRAME)).toEqual([{ event: "token", data: '{"delta": "Hi"}' }]);
  });

  it("handles frames split at arbitrary boundaries", () => {
    const parse = createSseParser();
    const frames = [...FRAME].flatMap((char) => parse(char));
    expect(frames).toEqual([{ event: "token", data: '{"delta": "Hi"}' }]);
  });

  it("returns multiple frames from one chunk", () => {
    const parse = createSseParser();
    const frames = parse(FRAME + "event: done\ndata: {}\n\n");
    expect(frames).toEqual([
      { event: "token", data: '{"delta": "Hi"}' },
      { event: "done", data: "{}" },
    ]);
  });

  it("tolerates CRLF line endings", () => {
    const parse = createSseParser();
    expect(parse("event: token\r\ndata: {}\r\n\r\n")).toEqual([
      { event: "token", data: "{}" },
    ]);
  });

  it("joins multiple data lines with a newline", () => {
    const parse = createSseParser();
    expect(parse("data: a\ndata: b\n\n")).toEqual([{ event: "message", data: "a\nb" }]);
  });

  it("ignores frames without data", () => {
    const parse = createSseParser();
    expect(parse("event: ping\n\n")).toEqual([]);
  });

  it("buffers an incomplete frame until its blank line arrives", () => {
    const parse = createSseParser();
    expect(parse("event: token\ndata: {}")).toEqual([]);
    expect(parse("\n\n")).toEqual([{ event: "token", data: "{}" }]);
  });
});
