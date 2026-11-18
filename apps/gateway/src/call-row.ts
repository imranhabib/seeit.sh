// Builds the ledger row for one call from what the request and response showed.

import { estimateTokens, type Harness, type RequestInfo, type Usage } from "@seeit/core";
import type { CallRow } from "./db/schema.ts";

export function callRow(b: {
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
    agentId: b.info.agentId,
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
export function estimateUnreported(info: RequestInfo, requestText: string | null, outputChars: number, completion: string): Usage | null {
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

export function usageColumns(u: Usage | null) {
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
