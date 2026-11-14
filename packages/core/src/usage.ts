// One usage shape for every provider.
//
// Providers count input differently:
// - Anthropic: `input_tokens` EXCLUDES cache reads and cache writes.
// - OpenAI:    `input_tokens` INCLUDES cached tokens (they are a subset).
// We store the Anthropic meaning: `inputTokens` is uncached input only, so
// total input = inputTokens + cacheReadTokens + cacheWriteTokens for both.

export type Usage = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** Thinking / reasoning tokens. Already included in outputTokens. */
  reasoningTokens: number;
  /** True when some numbers are gateway estimates, not provider-reported. */
  estimated: boolean;
};

/** Rough rule of thumb for English text and code. Only used for estimates. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

type Json = Record<string, any>;

/** Anthropic `usage` object (message_start, message_delta, or a non-streaming body). */
export function fromAnthropicUsage(u: Json): Usage {
  return {
    inputTokens: u.input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    reasoningTokens: u.output_tokens_details?.thinking_tokens ?? 0,
    estimated: false,
  };
}

/** OpenAI Responses `usage` object (from response.completed). */
export function fromOpenAIUsage(u: Json): Usage {
  const cacheRead = u.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (u.input_tokens ?? 0) - cacheRead - cacheWrite),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: u.output_tokens ?? 0,
    reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
    estimated: false,
  };
}
