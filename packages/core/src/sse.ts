// Incremental parser for Server-Sent Events (SSE), the format both Anthropic
// and OpenAI use for streaming responses.
//
// Network chunks do not line up with events: one chunk can hold half an event,
// or several events. So the parser keeps a buffer and only returns events
// that are complete (ended by a blank line).

export type SseEvent = {
  event?: string;
  data: string;
};

export function createSseParser() {
  let buffer = "";

  return {
    /** Add a chunk of text. Returns the events completed by this chunk. */
    push(chunk: string): SseEvent[] {
      // Normalize CRLF after appending, so a "\r\n" split across two chunks
      // is still handled.
      buffer = (buffer + chunk).replace(/\r\n/g, "\n");
      const events: SseEvent[] = [];
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const event = parseBlock(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (event) events.push(event);
      }
      return events;
    },

    /** Call at end of stream. Returns a last event that had no blank line after it. */
    flush(): SseEvent[] {
      const rest = buffer;
      buffer = "";
      const event = parseBlock(rest);
      return event ? [event] : [];
    },
  };
}

function parseBlock(block: string): SseEvent | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue; // ":" starts a comment (keep-alive)
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (event === undefined && data.length === 0) return null;
  return { event, data: data.join("\n") };
}
