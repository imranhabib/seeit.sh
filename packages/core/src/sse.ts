// SSE (Server-Sent Events) parsing, the format both Anthropic and OpenAI use
// for streaming responses.
//
// The framing work (buffering across chunk boundaries, CRLF / lone CR line
// endings, comments, id / retry fields) is done by the spec-compliant
// `eventsource-parser` library. This file only adapts it to a small
// push / flush API: feed text chunks in, get complete events out.

import { createParser } from "eventsource-parser";

export type SseEvent = {
  event?: string;
  data: string;
};

export function createSseParser() {
  let completed: SseEvent[] = [];
  const parser = createParser({
    onEvent: (e) => completed.push({ event: e.event, data: e.data }),
  });

  const take = () => {
    const events = completed;
    completed = [];
    return events;
  };

  return {
    /** Add a chunk of text. Returns the events completed by this chunk. */
    push(chunk: string): SseEvent[] {
      parser.feed(chunk);
      return take();
    },

    /**
     * Call at end of stream. Returns a last event that had no blank line after
     * it. The SSE spec says to drop such an event; we keep it on purpose,
     * because for a truncated call a partial last event still helps estimate
     * output tokens.
     */
    flush(): SseEvent[] {
      // A blank line is what dispatches an event, so supply the one the
      // stream never sent. If nothing is pending, this dispatches nothing.
      parser.feed("\n\n");
      parser.reset();
      return take();
    },
  };
}
