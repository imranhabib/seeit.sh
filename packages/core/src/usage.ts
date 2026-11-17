// One usage shape for every provider.
//
// Providers count input differently:
// - Anthropic: `input_tokens` EXCLUDES cache reads and cache writes.
// - OpenAI:    `input_tokens` INCLUDES cached tokens (they are a subset).
// We store the Anthropic meaning: `inputTokens` is uncached input only, so
// total input = inputTokens + cacheReadTokens + cacheWriteTokens for both.
//
// A field the provider did not send is null (unknown), never 0. A 0 would
// claim "no tokens" when we simply do not know.

export type Usage = {
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  /** Thinking / reasoning tokens. Already included in outputTokens. */
  reasoningTokens: number | null;
  /**
   * Codex only: `codex_rollout_budget_units` from response.completed usage, a
   * decimal number. Its meaning is not documented; stored so it can be studied.
   * Null when missing (always for Anthropic).
   */
  codexRolloutBudgetUnits: number | null;
  /** True when some numbers are gateway estimates, not provider-reported. */
  estimated: boolean;
};

/** Rough rule of thumb for English text and code. Only used for estimates. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

type Json = Record<string, any>;

/** The value if it is a number, otherwise null (missing, null, or a wrong type). */
function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/** Anthropic `usage` object (message_start, message_delta, or a non-streaming body). */
export function fromAnthropicUsage(u: Json): Usage {
  return {
    inputTokens: num(u.input_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
    outputTokens: num(u.output_tokens),
    reasoningTokens: num(u.output_tokens_details?.thinking_tokens),
    codexRolloutBudgetUnits: null,
    estimated: false,
  };
}

/** OpenAI Responses `usage` object (from response.completed). */
export function fromOpenAIUsage(u: Json): Usage {
  const input = num(u.input_tokens);
  const cacheRead = num(u.input_tokens_details?.cached_tokens);
  const cacheWrite = num(u.input_tokens_details?.cache_write_tokens);
  return {
    // Subtract the cached parts that were reported. A part that is missing is
    // unknown; we subtract nothing for it rather than guess.
    inputTokens: input === null ? null : Math.max(0, input - (cacheRead ?? 0) - (cacheWrite ?? 0)),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: num(u.output_tokens),
    reasoningTokens: num(u.output_tokens_details?.reasoning_tokens),
    // Source: codex-rs/codex-api/src/sse/responses.rs, ResponseCompletedUsage.
    codexRolloutBudgetUnits: num(u.codex_rollout_budget_units),
    estimated: false,
  };
}
