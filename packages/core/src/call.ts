// One proxied call as the gateway records it, and the analysis that turns it
// into ledger fields.
//
// RecordedCall is what the gateway sends to the ledger service (ADR 0007):
// the redacted request and response, plus what only the gateway can know
// (timings, whether the client left, whether reading upstream failed). All
// parsing happens in analyzeCall, so it can run in the ledger.

import { decideCompletion, type Completion } from "./completion.ts";
import { callFlags, type Flag } from "./flags.ts";
import { quotaHeaders, readRequest, usageFromJsonBody } from "./provider/index.ts";
import { estimateTokens, parseJson, type CallKind, type Harness, type RequestInfo, type StreamSummary, type Usage } from "./provider/model.ts";
import { interpretResponse } from "./response.ts";

export type RecordedCall = {
  id: string;
  /** ISO 8601, UTC. */
  startedAt: string;
  harness: Harness;
  method: string;
  /** Path and query after the harness prefix, for example "/v1/messages?beta=true". */
  path: string;
  /** From the gateway's turn tracker, until ADR 0008 moves turns to the ledger. */
  turnId: string | null;
  request: {
    /** Credential headers redacted (apps/gateway/src/redact.ts). */
    headers: Record<string, string>;
    /** The decoded body, or null when there was none. */
    body: string | null;
  };
  response: {
    /** null when the upstream request failed. */
    status: number | null;
    headers: Record<string, string>;
    body: string | null;
    /** How the body arrived: [characters, ms since start] per piece (see CapturedResponse). */
    pieces: [number, number][];
  };
  timeToResponseHeadersMs: number;
  timeToFirstChunkMs: number | null;
  timeToStreamEndMs: number;
  /** The harness disconnected before the response ended. */
  clientAborted: boolean;
  /** Reading from upstream failed (connection reset, or aborted because the client left). */
  readFailed: boolean;
};

/** One ledger row's fields. JSON columns are values here; each store serializes them its own way. */
export type CallFields = {
  id: string;
  startedAt: string;
  harness: Harness;
  harnessVersion: string | null;
  sessionId: string | null;
  turnId: string | null;
  agentId: string | null;
  kind: CallKind;
  method: string;
  path: string;
  httpStatus: number | null;
  completion: Completion;
  errorType: string | null;
  model: string | null;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  codexRolloutBudgetUnits: number | null;
  tokensEstimated: boolean;
  serverToolUse: Record<string, number> | null;
  timeToResponseHeadersMs: number;
  timeToFirstChunkMs: number | null;
  timeToFirstTokenMs: number | null;
  timeToStreamEndMs: number | null;
  toolsCount: number;
  toolsChars: number;
  instructionsChars: number;
  quota: Record<string, string> | null;
  /** Without "untested_harness_version": that check needs earlier rows, so the store adds it. */
  flags: Flag[];
  unknownEvents: Record<string, number> | null;
  unknownUsageFields: string[] | null;
};

export type AnalyzedCall = {
  fields: CallFields;
  /** What the response stream showed; null when analysis failed. */
  stream: StreamSummary | null;
  /** Set when analysis failed; the fields then record a gateway_error. */
  error?: unknown;
};

export function analyzeCall(call: RecordedCall): AnalyzedCall {
  const { harness, response } = call;
  const info = readRequest(harness, { method: call.method, path: call.path, headers: new Headers(call.request.headers), body: parseJson(call.request.body) });
  const base = callRow(call, info);
  const responseHeaders = new Headers(response.headers);

  let fields: CallFields;
  let stream: StreamSummary | null = null;
  let error: unknown;
  try {
    const contentType = responseHeaders.get("content-type");
    const interpreted = interpretResponse(harness, { text: response.body ?? "", pieces: response.pieces, contentType, timeToStreamEndMs: call.timeToStreamEndMs });
    const s = (stream = interpreted.summary);
    const completion = decideCompletion({
      status: response.status,
      isStream: interpreted.isStream,
      final: s.final,
      errorType: s.errorType,
      clientAborted: call.clientAborted,
      readFailed: call.readFailed,
      gatewayFailed: false,
      connectivityCheck: info.kind === "connectivity",
    });
    const usage =
      s.usage ??
      (interpreted.isStream ? null : usageFromJsonBody(harness, response.body ?? "")) ??
      estimateUnreported(info, call.request.body, s.outputChars, completion);

    fields = {
      ...base,
      httpStatus: response.status,
      completion,
      errorType: s.errorType,
      model: s.model ?? info.model,
      ...usageColumns(usage),
      timeToFirstChunkMs: call.timeToFirstChunkMs,
      timeToFirstTokenMs: s.timeToFirstTokenMs,
      timeToStreamEndMs: call.timeToStreamEndMs,
      quota: response.status === null ? null : quotaHeaders(responseHeaders),
      serverToolUse: s.serverToolUse,
      unknownEvents: s.unknownEvents,
      unknownUsageFields: s.unknownUsageFields,
    };
  } catch (err) {
    error = err;
    fields = { ...base, httpStatus: response.status, completion: "gateway_error", ...usageColumns(null) };
  }
  fields.flags = callFlags(fields, stream);
  return { fields, stream, ...(error === undefined ? {} : { error }) };
}

/** The fields known from the request alone; analysis fills in the rest. */
function callRow(call: RecordedCall, info: RequestInfo): Omit<CallFields, "completion" | keyof ReturnType<typeof usageColumns>> {
  return {
    id: call.id,
    startedAt: call.startedAt,
    harness: call.harness,
    harnessVersion: info.harnessVersion,
    sessionId: info.sessionId,
    turnId: call.turnId,
    agentId: info.agentId,
    kind: info.kind,
    method: call.method,
    path: call.path,
    httpStatus: null,
    errorType: null,
    model: info.model,
    serverToolUse: null,
    timeToResponseHeadersMs: call.timeToResponseHeadersMs,
    timeToFirstChunkMs: null,
    timeToFirstTokenMs: null,
    timeToStreamEndMs: null,
    toolsCount: info.context.toolsCount,
    toolsChars: info.context.toolsChars,
    instructionsChars: info.context.instructionsChars,
    quota: null,
    flags: [],
    unknownEvents: null,
    unknownUsageFields: null,
  };
}

// A model call that never reported usage (for example a Codex stream cut
// before response.completed) still cost tokens. Estimate both sides.
function estimateUnreported(info: RequestInfo, requestText: string | null, outputChars: number, completion: string): Usage | null {
  if (info.kind !== "turn" || completion === "complete" || !requestText) return null;
  return {
    inputTokens: estimateTokens(requestText.length),
    // The estimate counts the whole request; how much of it was cached is unknown.
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cacheWrite5mTokens: null,
    cacheWrite1hTokens: null,
    outputTokens: estimateTokens(outputChars),
    reasoningTokens: null,
    codexRolloutBudgetUnits: null,
    estimated: true,
  };
}

function usageColumns(u: Usage | null) {
  return {
    inputTokens: u?.inputTokens ?? null,
    cacheReadTokens: u?.cacheReadTokens ?? null,
    cacheWriteTokens: u?.cacheWriteTokens ?? null,
    cacheWrite5mTokens: u?.cacheWrite5mTokens ?? null,
    cacheWrite1hTokens: u?.cacheWrite1hTokens ?? null,
    outputTokens: u?.outputTokens ?? null,
    reasoningTokens: u?.reasoningTokens ?? null,
    codexRolloutBudgetUnits: u?.codexRolloutBudgetUnits ?? null,
    tokensEstimated: u?.estimated ?? false,
  };
}
