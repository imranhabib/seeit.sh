// Everything that happens to a call after the response has started: read the
// request, follow the turn, capture the response copy, analyze the call
// (analyzeCall in @seeit/core), then write the ledger row, the log line and
// the JSON recording. None of it is on the hot path: app.ts starts this
// without awaiting it.

import { analyzeCall, readRequest, type CallFields, type Harness, type RecordedCall } from "@seeit/core";
import { captureResponse } from "./capture.ts";
import type { Config } from "./config.ts";
import type { Ledger } from "./db/ledger.ts";
import type { CallRow } from "./db/schema.ts";
import type { Delivery } from "./delivery.ts";
import { createVersionCheck } from "./flags.ts";
import { logCall } from "./log.ts";
import { decodeRequestText, parseResponseBody, writeRecording } from "./recorder.ts";
import { redactHeaders } from "./redact.ts";
import { createTurnTracker } from "./turns.ts";

export type Hooks = {
  /** Called after a call's ledger row is written. */
  onCall?: (row: CallRow) => void;
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

/** Returns the function that records one call. State (turns, versions seen) lives across calls. */
export function createCallRecorder(config: Config, ledger: Ledger, hooks: Hooks = {}, delivery?: Delivery) {
  const turns = createTurnTracker();
  const isFirstUntested = createVersionCheck(ledger);

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
    // To the ledger service, if configured (queued; never waited for).
    delivery?.send(recorded);
    const { fields, error } = analyzeCall(recorded);
    if (error !== undefined) console.error(`[${harness}] analysis failed:`, error);

    // The version check reads the ledger, so it runs before this row is written.
    const flags: string[] = [...fields.flags];
    if (isFirstUntested(fields.harnessVersion)) flags.push("untested_harness_version");
    const row = sqliteRow({ ...fields, flags });

    await ledger.record(row, { request: requestText, response: recorded.response.body });
    logCall(row);
    hooks.onCall?.(row);

    const file = await writeRecording(config.recordDir, {
      id,
      harness,
      startedAt,
      timings: { timeToResponseHeadersMs, timeToFirstChunkMs: captured.timeToFirstChunkMs, timeToStreamEndMs: captured.timeToStreamEndMs },
      aborted: row.completion !== "complete",
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

/** SQLite stores JSON columns as text (apps/gateway/src/db/schema.ts). */
function sqliteRow(f: Omit<CallFields, "flags"> & { flags: string[] }): CallRow {
  const json = (v: unknown) => (v === null ? null : JSON.stringify(v));
  return {
    ...f,
    serverToolUse: json(f.serverToolUse),
    quota: json(f.quota),
    flags: JSON.stringify(f.flags),
    unknownEvents: json(f.unknownEvents),
    unknownUsageFields: json(f.unknownUsageFields),
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
