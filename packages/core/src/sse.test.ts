import { describe, expect, it } from "vitest";
import { createSseParser, type SseEvent } from "./sse.ts";

const STREAM =
  'event: message_start\ndata: {"type":"message_start"}\n\n' +
  ": keep-alive comment\n\n" +
  'event: content_block_delta\r\ndata: {"text":"hi"}\r\n\r\n' +
  "data: line one\ndata: line two\n\n" +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

const EXPECTED: SseEvent[] = [
  { event: "message_start", data: '{"type":"message_start"}' },
  { event: "content_block_delta", data: '{"text":"hi"}' },
  { event: undefined, data: "line one\nline two" },
  { event: "message_stop", data: '{"type":"message_stop"}' },
];

function parseInChunks(text: string, size: number): SseEvent[] {
  const parser = createSseParser();
  const events: SseEvent[] = [];
  for (let i = 0; i < text.length; i += size) {
    events.push(...parser.push(text.slice(i, i + size)));
  }
  events.push(...parser.flush());
  return events;
}

describe("createSseParser", () => {
  it("parses a whole stream in one chunk", () => {
    expect(parseInChunks(STREAM, STREAM.length)).toEqual(EXPECTED);
  });

  it.each([1, 2, 3, 7, 13])("gives the same result with %i-char chunks", (size) => {
    expect(parseInChunks(STREAM, size)).toEqual(EXPECTED);
  });

  it("handles lone CR line endings (the spec allows them)", () => {
    expect(parseInChunks("event: a\rdata: 1\r\rdata: 2\r\r", 1)).toEqual([
      { event: "a", data: "1" },
      { event: undefined, data: "2" },
    ]);
  });

  it("does not dispatch an event that has no data line", () => {
    expect(parseInChunks("event: lonely\n\ndata: x\n\n", 3)).toEqual([{ event: undefined, data: "x" }]);
  });

  it("returns a final event without a trailing blank line on flush", () => {
    const parser = createSseParser();
    expect(parser.push("event: done\ndata: x")).toEqual([]);
    expect(parser.flush()).toEqual([{ event: "done", data: "x" }]);
  });
});
