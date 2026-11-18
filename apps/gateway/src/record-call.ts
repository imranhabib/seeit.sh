// Everything that happens to a call after the response has started: read the
// request, follow the turn, capture the response copy, then queue the
// recorded call for the ledger service (ADR 0007), which analyzes and stores
// it. Also the log line and the optional JSON recording. None of it is on
// the hot path: app.ts starts this without awaiting it.

import { readRequest, type Harness, type RecordedCall } from "@seeit/core";
import { captureResponse } from "./capture.ts";
import type { Config } from "./config.ts";
import type { Delivery } from "./delivery.ts";
import { decodeRequestText, parseResponseBody, writeRecording } from "./recorder.ts";
import { redactHeaders } from "./redact.ts";
import { createTurnTracker } from "./turns.ts";

export type Hooks = {
  /** Called with each recorded call, when it is queued for the ledger. */
  onRecordedCall?: (call: RecordedCall) => void;
  /** Called after a JSON recording is written. */
  onRecorded?: (file: string) => void;
};

/** What the hot path knows about one proxied call. */
export type ProxiedCall = {
  id: string;
  startedAt: string;
  /** performance.now() when the call arrived; all timings count from here. */
  start: number;
  harness: Harness;
  method: string;
  path: string;
  /** The request headers exactly as the harness sent them. */
  requestHeaders: Headers;
  requestBody: ArrayBuffer | undefined;
  /** Aborts when the harness disconnects. */
  signal: AbortSignal;
  /** null when the upstream request failed. */
  upstream: Response | null;
  /** The observer's branch of the teed response body. */
  responseStream: ReadableStream<Uint8Array> | null;
  timeToResponseHeadersMs: number;
};

/** Returns the function that records one call. The turn tracker's state lives across calls. */
export function createCallRecorder(config: Config, hooks: Hooks = {}, delivery?: Delivery) {
  const turns = createTurnTracker();

  return async function recordCall(call: ProxiedCall): Promise<void> {
    const { id, startedAt, start, harness, method, path, requestHeaders, requestBody, signal, upstream, responseStream, timeToResponseHeadersMs } = call;
    // Yield first, so request parsing happens after the response has started.
    // setImmediate callbacks run in the order they were scheduled, so the
    // turn tracker still sees calls in request order.
    await new Promise((resolve) => setImmediate(resolve));

    const requestText = requestBody ? decodeRequestText(requestBody, requestHeaders.get("content-encoding")) : null;
    // The turn tracker stays here until ADR 0008 moves turns to the ledger.
    const info = readRequest(harness, { method, path, headers: requestHeaders, body: parseJson(requestText) });
    const turnId = turns.turnFor(info);

    const captured = await captureResponse(responseStream, start);
    // What the ledger service will receive (ADR 0007): redacted, parsed nowhere yet.
    const recorded: RecordedCall = {
      id,
      startedAt,
      harness,
      method,
      path,
      turnId,
      request: { headers: redactHeaders(requestHeaders), body: requestText },
      response: {
        status: upstream?.status ?? null,
        headers: upstream ? redactHeaders(upstream.headers) : {},
        body: captured.text || null,
        pieces: captured.pieces,
      },
      timeToResponseHeadersMs,
      timeToFirstChunkMs: captured.timeToFirstChunkMs,
      timeToStreamEndMs: captured.timeToStreamEndMs,
      clientAborted: signal.aborted,
      readFailed: captured.readFailed,
    };
    // To the ledger service (queued; never waited for).
    delivery?.send(recorded);
    hooks.onRecordedCall?.(recorded);
    console.log(`[${harness}] ${method} ${path} -> ${recorded.response.status ?? "-"} (${Math.round(captured.timeToStreamEndMs)} ms)`);

    const file = await writeRecording(config.recordDir, {
      id,
      harness,
      startedAt,
      timings: { timeToResponseHeadersMs, timeToFirstChunkMs: captured.timeToFirstChunkMs, timeToStreamEndMs: captured.timeToStreamEndMs },
      aborted: recorded.clientAborted || recorded.readFailed || recorded.response.status === null,
      request: { method, path, headers: recorded.request.headers, body: parseJson(requestText) ?? requestText },
      response: {
        status: recorded.response.status ?? 0,
        headers: recorded.response.headers,
        ...parseResponseBody(recorded.response.body ?? "", upstream?.headers.get("content-type") ?? null),
      },
    });
    hooks.onRecorded?.(file);
  };
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
