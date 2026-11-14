// Phase 0 recorder: turns one proxied call into a JSON file, so we can see
// what each harness actually sends and receives. Everything here runs OFF the
// hot path, on the recorder's branch of the teed response stream.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { createSseParser } from "@seeit/core";

export type Recording = {
  id: string;
  harness: string;
  startedAt: string;
  timings: {
    /** Time until the upstream response status and headers arrived (the body may still be on its way). */
    timeToResponseHeadersMs: number;
    /** Time until the first body chunk arrived (time to first token, roughly). */
    timeToFirstChunkMs: number | null;
    timeToStreamEndMs: number;
  };
  /** True if the stream ended early (for example the client disconnected). */
  aborted: boolean;
  request: { method: string; path: string; headers: Record<string, string>; body: unknown };
  response: {
    status: number;
    headers: Record<string, string>;
    events?: { event?: string; data: unknown }[];
    body?: unknown;
  };
};

/** Request bodies are forwarded raw, so they may be compressed. Decode them for analysis and storage. */
export function decodeRequestText(raw: ArrayBuffer, encoding: string | null): string | null {
  if (raw.byteLength === 0) return null;
  let buf = Buffer.from(raw);
  try {
    if (encoding === "gzip") buf = zlib.gunzipSync(buf);
    else if (encoding === "br") buf = zlib.brotliDecompressSync(buf);
    else if (encoding === "deflate") buf = zlib.inflateSync(buf);
    else if (encoding === "zstd") buf = zlib.zstdDecompressSync(buf);
  } catch {
    return `[could not decode ${encoding} body, ${raw.byteLength} bytes]`;
  }
  return buf.toString("utf8");
}

export function parseResponseBody(text: string, contentType: string | null): Partial<Recording["response"]> {
  // The ChatGPT Codex backend streams SSE with no content-type header, so also
  // check whether the body itself looks like SSE.
  if (contentType?.includes("text/event-stream") || /^(event|data):/.test(text)) {
    const parser = createSseParser();
    const events = [...parser.push(text), ...parser.flush()];
    return { events: events.map((e) => ({ event: e.event, data: parseJsonOrText(e.data) })) };
  }
  return { body: parseJsonOrText(text) };
}

export async function writeRecording(dir: string, rec: Recording): Promise<string> {
  const day = rec.startedAt.slice(0, 10);
  const name = `${rec.startedAt.replace(/[:.]/g, "-")}-${rec.harness}-${rec.id}.json`;
  await mkdir(join(dir, day), { recursive: true });
  const file = join(dir, day, name);
  await writeFile(file, JSON.stringify(rec, null, 2));
  return file;
}

function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
