// Converts OpenAI Responses `usage` (Codex) into the shared Usage shape
// (provider/model.ts).

import { num, type Usage } from "../model.ts";
import type { OpenAIUsage } from "./model.ts";

/** OpenAI Responses `usage` object (from response.completed). */
export function fromOpenAIUsage(u: OpenAIUsage): Usage {
  const input = num(u.input_tokens);
  const cacheRead = num(u.input_tokens_details?.cached_tokens);
  const cacheWrite = num(u.input_tokens_details?.cache_write_tokens);
  return {
    // Subtract the cached parts that were reported. A part that is missing is
    // unknown; we subtract nothing for it rather than guess.
    inputTokens: input === null ? null : Math.max(0, input - (cacheRead ?? 0) - (cacheWrite ?? 0)),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cacheWrite5mTokens: null,
    cacheWrite1hTokens: null,
    outputTokens: num(u.output_tokens),
    reasoningTokens: num(u.output_tokens_details?.reasoning_tokens),
    // Source: codex-rs/codex-api/src/sse/responses.rs, ResponseCompletedUsage.
    codexRolloutBudgetUnits: num(u.codex_rollout_budget_units),
    estimated: false,
  };
}
