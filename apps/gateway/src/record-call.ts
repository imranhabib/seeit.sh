// Everything that happens to a call after the response has started: read the
// request, follow the turn, observe the response copy, then write the ledger
// row, the log line and the JSON recording. None of it is on the hot path:
// app.ts starts this without awaiting it.

import { decideCompletion, readRequest, type Harness, type StreamSummary } from "@seeit/core";
import { callRow, estimateUnreported, usageColumns } from "./call-row.ts";
import type { Config } from "./config.ts";
import type { Ledger } from "./db/ledger.ts";
import type { CallRow } from "./db/schema.ts";
import { callFlags, createVersionCheck } from "./flags.ts";
import { logCall } from "./log.ts";
import { observeResponse } from "./observe.ts";
import { quotaHeaders, usageFromJsonBody } from "./provider/index.ts";
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
export function createCallRecorder(config: Config, ledger: Ledger, hooks: Hooks = {}) {
  const turns = createTurnTracker();
  const isFirstUntested = createVersionCheck(ledger);

  return async function recordCall(call: ProxiedCall): Promise<void> {
    const { id, startedAt, start, harness, method, path, requestHeaders, requestBody, signal, upstream, responseStream, timeToResponseHeadersMs } = call;
    // Yield first, so request parsing happens after the response has started.
    // setImmediate callbacks run in the order they were scheduled, so the
    // turn tracker still sees calls in request order.
    await new Promise((resolve) => setImmediate(resolve));

    const requestText = requestBody ? decodeRequestText(requestBody, requestHeaders.get("content-encoding")) : null;
    const info = readRequest(harness, { method, path, headers: requestHeaders, body: parseJson(requestText) });
    const turnId = turns.turnFor(info);
    const base = { id, startedAt, harness, method, path, info, turnId, timeToResponseHeadersMs };

    let row: CallRow;
    let responseText: string | null = null;
    // What the response stream showed; stays null if analysis failed.
    let stream: StreamSummary | null = null;
    try {
      const observed = await observeResponse(responseStream, harness, upstream?.headers.get("content-type") ?? null, start);
      responseText = observed.text || null;
      const s = (stream = observed.summary);
      const completion = decideCompletion({
        status: upstream?.status ?? null,
        isStream: observed.isStream,
        final: s.final,
        errorType: s.errorType,
        clientAborted: signal.aborted,
        readFailed: observed.readFailed,
        gatewayFailed: false,
        connectivityCheck: info.kind === "connectivity",
      });
      const usage =
        s.usage ??
        (observed.isStream ? null : usageFromJsonBody(harness, observed.text)) ??
        estimateUnreported(info, requestText, s.outputChars, completion);

      row = {
        ...callRow(base),
        httpStatus: upstream?.status ?? null,
        completion,
        errorType: s.errorType,
        model: s.model ?? info.model,
        ...usageColumns(usage),
        timeToFirstChunkMs: observed.timeToFirstChunkMs,
        timeToFirstTokenMs: s.timeToFirstTokenMs,
        timeToStreamEndMs: observed.timeToStreamEndMs,
        quota: upstream ? quotaHeaders(upstream.headers) : null,
        serverToolUse: s.serverToolUse ? JSON.stringify(s.serverToolUse) : null,
        unknownEvents: JSON.stringify(s.unknownEvents),
        unknownUsageFields: JSON.stringify(s.unknownUsageFields),
      };
    } catch (err) {
      console.error(`[${harness}] analysis failed:`, err);
      row = { ...callRow(base), httpStatus: upstream?.status ?? null, completion: "gateway_error", ...usageColumns(null) };
    }

    // Invariant flags. The version check reads the ledger, so it runs
    // before this row is written.
    const flags = callFlags(row, stream);
    if (isFirstUntested(row.harnessVersion)) flags.push("untested_harness_version");
    row.flags = JSON.stringify(flags);

    await ledger.record(row, { request: requestText, response: responseText });
    logCall(row);
    hooks.onCall?.(row);

    const file = await writeRecording(config.recordDir, {
      id,
      harness,
      startedAt,
      timings: {
        timeToResponseHeadersMs,
        timeToFirstChunkMs: row.timeToFirstChunkMs ?? null,
        timeToStreamEndMs: row.timeToStreamEndMs ?? performance.now() - start,
      },
      aborted: row.completion !== "complete",
      request: { method, path, headers: redactHeaders(requestHeaders), body: parseJson(requestText) ?? requestText },
      response: {
        status: upstream?.status ?? 0,
        headers: upstream ? redactHeaders(upstream.headers) : {},
        ...parseResponseBody(responseText ?? "", upstream?.headers.get("content-type") ?? null),
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
