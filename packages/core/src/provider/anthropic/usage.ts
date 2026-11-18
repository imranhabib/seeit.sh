// Converts Anthropic `usage` into the shared Usage shape (provider/model.ts).

import { num, type Usage } from "../model.ts";
import type { AnthropicUsage } from "./model.ts";

/** Anthropic `usage` object (message_start, message_delta, or a non-streaming body). */
export function fromAnthropicUsage(u: AnthropicUsage): Usage {
  return {
    inputTokens: num(u.input_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
    cacheWrite5mTokens: num(u.cache_creation?.ephemeral_5m_input_tokens),
    cacheWrite1hTokens: num(u.cache_creation?.ephemeral_1h_input_tokens),
    outputTokens: num(u.output_tokens),
    reasoningTokens: num(u.output_tokens_details?.thinking_tokens),
    codexRolloutBudgetUnits: null,
    estimated: false,
  };
}
