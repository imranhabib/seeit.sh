// The proxy. Data flow for one call:
//
//   harness ──request──▶ gateway ──same bytes──▶ upstream
//   harness ◀──chunk by chunk── tee ◀──stream── upstream
//                                └──copy──▶ observe (parse events, usage, timings)
//                                             └─▶ ledger row + gzipped bodies (+ JSON recording)
//
// Everything after the tee runs in the background. The hot path is only:
// read request bytes → fetch → tee → return the client stream.

import { randomUUID } from "node:crypto";
import { decideCompletion, estimateTokens, readRequest, type Harness, type RequestInfo, type Usage } from "@seeit/core";
import { Hono } from "hono";
import type { Config } from "./config.ts";
import type { Ledger } from "./db/ledger.ts";
import type { CallRow } from "./db/schema.ts";
import { observeResponse, quotaHeaders, usageFromJsonBody } from "./observe.ts";
import { decodeRequestText, parseResponseBody, writeRecording } from "./recorder.ts";
import { redactHeaders } from "./redact.ts";
import { createTurnTracker } from "./turns.ts";

// Hop-by-hop headers belong to one connection and must not be forwarded.
const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-connection"];

type Hooks = {
  /** Called after a call's ledger row is written. */
  onCall?: (row: CallRow) => void;
  /** Called after a JSON recording is written. */
  onRecorded?: (file: string) => void;
};

export function createApp(config: Config, ledger: Ledger, hooks: Hooks = {}) {
  const app = new Hono();
  const turns = createTurnTracker();

  app.all("/:harness/*", async (c) => {
    const harness = c.req.param("harness") as Harness;
    const upstreamBase = config.upstreams[harness];
    if (!upstreamBase) return c.json({ error: `unknown harness "${harness}"` }, 404);

    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const start = performance.now();

    // "/claude/v1/messages?beta=true" -> "https://api.anthropic.com/v1/messages?beta=true"
    const url = new URL(c.req.url);
    const path = url.pathname.slice(harness.length + 1) + url.search;

    const reqHeaders = new Headers(c.req.raw.headers);
    for (const h of [...HOP_BY_HOP, "host", "content-length"]) reqHeaders.delete(h);
    // Let fetch pick accept-encoding itself. It then decompresses exactly the
    // encodings it asked for, so the client always receives plain bytes.
    reqHeaders.delete("accept-encoding");

    const method = c.req.method;
    // The request body is small compared with the response, and we need it for
    // analysis, so reading it fully here is fine.
    const reqBody = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();

    let upstream: Response | null = null;
    let fetchError: unknown = null;
    try {
      upstream = await fetch(upstreamBase + path, {
        method,
        headers: reqHeaders,
        body: reqBody,
        // If the harness disconnects (user pressed Esc), abort upstream too, so
        // the provider stops generating tokens nobody will read.
        signal: c.req.raw.signal,
      });
    } catch (err) {
      fetchError = err;
    }
    const timeToResponseHeadersMs = performance.now() - start;

    const [toClient, toObserver] = upstream?.body ? upstream.body.tee() : [null, null];

    // Not awaited: analysis and storage must never delay the response.
    void (async () => {
      // Yield first, so request parsing happens after the response has started.
      // setImmediate callbacks run in the order they were scheduled, so the
      // turn tracker still sees calls in request order.
      await new Promise((resolve) => setImmediate(resolve));

      const requestText = reqBody ? decodeRequestText(reqBody, c.req.header("content-encoding") ?? null) : null;
      const info = readRequest(harness, { method, path, headers: c.req.raw.headers, body: parseJson(requestText) });
      const turnId = turns.turnFor(info);
      const base = { id, startedAt, harness, method, path, info, turnId, timeToResponseHeadersMs };

      let row: CallRow;
      let responseText: string | null = null;
      try {
        const observed = await observeResponse(toObserver, harness, upstream?.headers.get("content-type") ?? null, start);
        responseText = observed.text || null;
        const s = observed.summary;
        const completion = decideCompletion({
          status: upstream?.status ?? null,
          isStream: observed.isStream,
          final: s.final,
          errorType: s.errorType,
          clientAborted: c.req.raw.signal.aborted,
          readFailed: observed.readFailed,
          gatewayFailed: false,
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
        };
      } catch (err) {
        console.error(`[${harness}] analysis failed:`, err);
        row = { ...callRow(base), httpStatus: upstream?.status ?? null, completion: "gateway_error", ...usageColumns(null) };
      }

      await ledger.record(row, { request: requestText, response: responseText });
      log(row);
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
        request: { method, path, headers: redactHeaders(c.req.raw.headers), body: parseJson(requestText) ?? requestText },
        response: {
          status: upstream?.status ?? 0,
          headers: upstream ? redactHeaders(upstream.headers) : {},
          ...parseResponseBody(responseText ?? "", upstream?.headers.get("content-type") ?? null),
        },
      });
      hooks.onRecorded?.(file);
    })().catch((err) => console.error(`[${harness}] recording failed:`, err));

    if (!upstream) {
      if (!c.req.raw.signal.aborted) console.error(`[${harness}] upstream request failed:`, fetchError);
      return c.json({ error: "upstream request failed" }, 502);
    }

    const resHeaders = new Headers(upstream.headers);
    // fetch already decompressed the body, so these headers would now be wrong.
    for (const h of [...HOP_BY_HOP, "content-encoding", "content-length"]) resHeaders.delete(h);
    return new Response(toClient, { status: upstream.status, headers: resHeaders });
  });

  return app;
}

function callRow(b: {
  id: string;
  startedAt: string;
  harness: Harness;
  method: string;
  path: string;
  info: RequestInfo;
  turnId: string | null;
  timeToResponseHeadersMs: number;
}): Omit<CallRow, "completion" | "tokensEstimated"> {
  return {
    id: b.id,
    startedAt: b.startedAt,
    harness: b.harness,
    harnessVersion: b.info.harnessVersion,
    sessionId: b.info.sessionId,
    turnId: b.turnId,
    kind: b.info.kind,
    method: b.method,
    path: b.path,
    model: b.info.model,
    timeToResponseHeadersMs: b.timeToResponseHeadersMs,
    toolsCount: b.info.context.toolsCount,
    toolsChars: b.info.context.toolsChars,
    instructionsChars: b.info.context.instructionsChars,
  };
}

// A model call that never reported usage (for example a Codex stream cut
// before response.completed) still cost tokens. Estimate both sides.
function estimateUnreported(info: RequestInfo, requestText: string | null, outputChars: number, completion: string): Usage | null {
  if (info.kind !== "turn" || completion === "complete" || !requestText) return null;
  return {
    inputTokens: estimateTokens(requestText.length),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: estimateTokens(outputChars),
    reasoningTokens: 0,
    estimated: true,
  };
}

function usageColumns(u: Usage | null) {
  return {
    inputTokens: u?.inputTokens ?? null,
    cacheReadTokens: u?.cacheReadTokens ?? null,
    cacheWriteTokens: u?.cacheWriteTokens ?? null,
    outputTokens: u?.outputTokens ?? null,
    reasoningTokens: u?.reasoningTokens ?? null,
    tokensEstimated: u?.estimated ?? false,
  };
}

function log(r: CallRow) {
  const tokens =
    r.inputTokens === null
      ? ""
      : ` in=${r.inputTokens} cache_read=${r.cacheReadTokens} cache_write=${r.cacheWriteTokens} out=${r.outputTokens}${r.tokensEstimated ? " (est.)" : ""}`;
  console.log(`[${r.harness}] ${r.method} ${r.path} -> ${r.httpStatus ?? "-"} ${r.completion} ${r.kind}${tokens} (${Math.round(r.timeToStreamEndMs ?? 0)} ms)`);
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
