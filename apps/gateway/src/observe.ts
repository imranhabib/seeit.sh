// Reads the recorder's copy of the response (off the hot path) and turns it
// into a summary: events, usage, timings, and how far the stream got.

import {
  createInterpreter,
  createSseParser,
  fromAnthropicUsage,
  fromOpenAIUsage,
  type Harness,
  type StreamSummary,
  type Usage,
} from "@seeit/core";

export type Observed = {
  /** The full response body as text (for body storage). */
  text: string;
  isStream: boolean;
  timeToFirstChunkMs: number | null;
  timeToStreamEndMs: number;
  /** Reading from upstream failed (connection reset, or aborted because the client left). */
  readFailed: boolean;
  summary: StreamSummary;
};

const PROVIDER = { claude: "anthropic", codex: "openai-responses" } as const;

export async function observeResponse(
  stream: ReadableStream<Uint8Array> | null,
  harness: Harness,
  contentType: string | null,
  start: number,
): Promise<Observed> {
  const decoder = new TextDecoder();
  const parser = createSseParser();
  const interpreter = createInterpreter(PROVIDER[harness]);
  let text = "";
  let timeToFirstChunkMs: number | null = null;
  let readFailed = false;
  // The ChatGPT backend streams SSE without a content-type header, so when
  // the header is missing we decide from the first text that arrives.
  let isStream: boolean | null = contentType?.includes("text/event-stream") ? true : null;

  const feed = (piece: string, atMs: number) => {
    for (const e of parser.push(piece)) interpreter.onEvent(e, atMs);
  };

  if (stream) {
    try {
      for await (const chunk of stream) {
        const atMs = performance.now() - start;
        timeToFirstChunkMs ??= atMs;
        const piece = decoder.decode(chunk, { stream: true });
        text += piece;
        if (isStream === null && text.trim()) {
          isStream = /^(event|data|id|retry)?:/.test(text.trimStart());
          if (isStream) feed(text, atMs); // feed everything received so far
        } else if (isStream) {
          feed(piece, atMs);
        }
      }
    } catch {
      readFailed = true;
    }
  }
  const timeToStreamEndMs = performance.now() - start;
  const rest = decoder.decode();
  text += rest;
  if (isStream) {
    feed(rest, timeToStreamEndMs);
    for (const e of parser.flush()) interpreter.onEvent(e, timeToStreamEndMs);
  }

  return { text, isStream: isStream === true, timeToFirstChunkMs, timeToStreamEndMs, readFailed, summary: interpreter.summary() };
}

/** Usage from a non-streaming JSON body (for example Claude's startup quota probe). */
export function usageFromJsonBody(harness: Harness, text: string): Usage | null {
  try {
    const usage = JSON.parse(text)?.usage;
    if (!usage || typeof usage !== "object") return null;
    return harness === "claude" ? fromAnthropicUsage(usage) : fromOpenAIUsage(usage);
  } catch {
    return null;
  }
}

const QUOTA_HEADER = /^(anthropic-ratelimit-unified-|x-codex-(primary|secondary)-|x-codex-plan-type$|x-codex-active-limit$)/;

/** Plan-quota headers as a JSON string, or null when the response has none (PLAN.md, Phase 2). */
export function quotaHeaders(headers: Headers): string | null {
  const quota: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (QUOTA_HEADER.test(name)) quota[name] = value;
  });
  return Object.keys(quota).length ? JSON.stringify(quota) : null;
}
