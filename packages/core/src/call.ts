// One proxied call as the gateway records it, and the analysis that turns it
// into ledger fields.
//
// RecordedCall is what the gateway sends to the ledger service (ADR 0007):
// the redacted request and response, plus what only the gateway can know
// (timings, whether the client left, whether reading upstream failed). All
// parsing happens in analyzeCall, so it can run in the ledger.

import { requestPieces } from "./pieces.ts";
import { decideCompletion, type Completion } from "./completion.ts";
import { callFlags, type Flag } from "./flags.ts";
import { quotaHeaders, readCallDetails, readCallRecords, readRequest, usageFromJsonBody } from "./provider/index.ts";
import { estimateTokens, parseJson, type CallKind, type Harness, type RequestInfo, type StreamSummary, type Usage } from "./provider/model.ts";
import { NO_DETAILS, type CallDetails, type CallRecords } from "./records.ts";
import { interpretResponse, streamEvents } from "./response.ts";

export type RecordedCall = {
  id: string;
  /** seeit's own user (ADR 0009): the gateway's SEEIT_USER_ID, "local" by default. */
  userId: string;
  /** Per gateway process, in request order; breaks ties in startedAt (ADR 0008). */
  seq: number;
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
export type CallFields = CallDetails & {
  id: string;
  userId: string;
  seq: number;
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
  /** Rows for the ledger's other tables (ADR 0009); empty when analysis failed, except the request pieces. */
  records: CallRecords;
  /** Where the call's turn ID came from: the harness sent it, or the gateway inferred it. Null without a turn. */
  turnSource: "harness" | "inferred" | null;
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
  let records: CallRecords;
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
    const input = {
      harness,
      method: call.method,
      path: call.path,
      status: response.status,
      requestHeaders: new Headers(call.request.headers),
      requestText: call.request.body,
      responseHeaders,
      responseText: response.body,
      events: interpreted.isStream ? streamEvents(response.body ?? "") : [],
      usage,
      quota: fields.quota,
    };
    Object.assign(fields, readCallDetails(input));
    records = readCallRecords(input);
  } catch (err) {
    error = err;
    fields = { ...base, httpStatus: response.status, completion: "gateway_error", ...usageColumns(null) };
    // The request is still stored, so a failed analysis can be run again later.
    records = { ...NO_RECORDS, pieces: requestPieces(harness, call.request.body) };
  }
  fields.flags = callFlags(fields, stream);
  const turnSource = call.turnId === null ? null : call.turnId === info.explicitTurnId ? "harness" : "inferred";
  return { fields, records, turnSource, stream, ...(error === undefined ? {} : { error }) };
}

/** The fields known from the request alone; analysis fills in the rest. */
function callRow(call: RecordedCall, info: RequestInfo): Omit<CallFields, "completion" | keyof ReturnType<typeof usageColumns>> {
  return {
    ...NO_DETAILS,
    id: call.id,
    userId: call.userId,
    seq: call.seq,
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

const NO_RECORDS: CallRecords = { pieces: [], toolUses: [], toolResults: [], quotaWindows: [], contextParts: [], modelCatalog: [] };

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
