// Reads a captured response: the body text plus when each piece arrived.
//
// The gateway captures the response off the hot path (apps/gateway/src/capture.ts);
// whoever analyzes it (the gateway until cutover, then the ledger service)
// replays the pieces through the stream parser at the times they arrived,
// so timings such as time to first token come out the same as if the stream
// had been parsed live.

import { PROVIDER_FOR, createInterpreter } from "./provider/index.ts";
import { parseJson, type Harness, type Json, type StreamSummary } from "./provider/model.ts";
import { createSseParser } from "./sse.ts";

export type CapturedResponse = {
  /** The whole decoded body. */
  text: string;
  /**
   * How the body arrived: [characters, ms since the call started] per
   * decoded piece, in order. The lengths add up to text.length.
   */
  pieces: [number, number][];
  contentType: string | null;
  /** When the body ended (ms since the call started). */
  timeToStreamEndMs: number;
};

export type InterpretedResponse = { isStream: boolean; summary: StreamSummary };

export function interpretResponse(harness: Harness, response: CapturedResponse): InterpretedResponse {
  const parser = createSseParser();
  const interpreter = createInterpreter(PROVIDER_FOR[harness]);
  // The ChatGPT backend streams SSE without a content-type header, so when
  // the header is missing we decide from the first text that arrives.
  let isStream: boolean | null = response.contentType?.includes("text/event-stream") ? true : null;
  let seen = "";
  let offset = 0;

  const feed = (piece: string, atMs: number) => {
    for (const e of parser.push(piece)) interpreter.onEvent(e, atMs);
  };

  for (const [length, atMs] of response.pieces) {
    const piece = response.text.slice(offset, offset + length);
    offset += length;
    if (isStream === null) {
      seen += piece;
      if (!seen.trim()) continue;
      isStream = /^(event|data|id|retry)?:/.test(seen.trimStart());
      if (isStream) feed(seen, atMs); // feed everything received so far
    } else if (isStream) {
      feed(piece, atMs);
    }
  }
  if (isStream) {
    for (const e of parser.flush()) interpreter.onEvent(e, response.timeToStreamEndMs);
  }
  return { isStream: isStream === true, summary: interpreter.summary() };
}

/** The JSON data of every event in a stream body, for analysis that reads whole events (ADR 0009 details). */
export function streamEvents(text: string): Json[] {
  const parser = createSseParser();
  const events = [...parser.push(text), ...parser.flush()];
  return events.map((e) => parseJson(e.data)).filter((d): d is Json => d !== null);
}
