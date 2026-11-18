// Reads the recorder's copy of the response (off the hot path): the body
// text, and when each piece arrived. Parsing happens later, from this
// capture (analyzeCall in @seeit/core), so it can run in the ledger.

export type Captured = {
  /** The full response body as text. */
  text: string;
  /** [characters, ms since the call started] per decoded piece (CapturedResponse in @seeit/core). */
  pieces: [number, number][];
  timeToFirstChunkMs: number | null;
  timeToStreamEndMs: number;
  /** Reading from upstream failed (connection reset, or aborted because the client left). */
  readFailed: boolean;
};

export async function captureResponse(stream: ReadableStream<Uint8Array> | null, start: number): Promise<Captured> {
  const decoder = new TextDecoder();
  let text = "";
  const pieces: [number, number][] = [];
  let timeToFirstChunkMs: number | null = null;
  let readFailed = false;

  if (stream) {
    try {
      for await (const chunk of stream) {
        const atMs = performance.now() - start;
        timeToFirstChunkMs ??= atMs;
        const piece = decoder.decode(chunk, { stream: true });
        text += piece;
        pieces.push([piece.length, atMs]);
      }
    } catch {
      readFailed = true;
    }
  }
  const timeToStreamEndMs = performance.now() - start;
  const rest = decoder.decode();
  if (rest) {
    text += rest;
    pieces.push([rest.length, timeToStreamEndMs]);
  }
  return { text, pieces, timeToFirstChunkMs, timeToStreamEndMs, readFailed };
}
