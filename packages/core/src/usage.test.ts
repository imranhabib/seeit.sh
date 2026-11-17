import { describe, expect, it } from "vitest";
import { fromAnthropicUsage, fromOpenAIUsage } from "./usage.ts";

// A missing field is unknown, not zero (PLAN.md follow-up step 3, moved into
// step 1 so the "complete but no usage" check can see it).
describe("missing usage fields stay null", () => {
  it("anthropic", () => {
    expect(fromAnthropicUsage({ input_tokens: 10, output_tokens: 2 })).toEqual({
      inputTokens: 10,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      cacheWrite5mTokens: null,
      cacheWrite1hTokens: null,
      outputTokens: 2,
      reasoningTokens: null,
      codexRolloutBudgetUnits: null,
      estimated: false,
    });
    expect(fromAnthropicUsage({})).toMatchObject({ inputTokens: null, outputTokens: null });
  });

  it("openai: subtracts only the cached parts that were reported", () => {
    expect(fromOpenAIUsage({ input_tokens: 100, output_tokens: 5 })).toEqual({
      inputTokens: 100,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      cacheWrite5mTokens: null,
      cacheWrite1hTokens: null,
      outputTokens: 5,
      reasoningTokens: null,
      codexRolloutBudgetUnits: null,
      estimated: false,
    });
    expect(fromOpenAIUsage({ input_tokens: 100, input_tokens_details: { cached_tokens: 40 } })).toMatchObject({ inputTokens: 60, cacheReadTokens: 40, cacheWriteTokens: null });
    expect(fromOpenAIUsage({ output_tokens: 5 })).toMatchObject({ inputTokens: null, outputTokens: 5 });
  });

  // PLAN.md live-run finding 6: a 1-hour cache write is billed higher than a
  // 5-minute one. Source: BetaCacheCreation in @anthropic-ai/sdk 1.4.0.
  it("anthropic: splits cache writes by lifetime when cache_creation is present", () => {
    const u = fromAnthropicUsage({ input_tokens: 4, cache_creation_input_tokens: 154, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 154 } });
    expect(u).toMatchObject({ cacheWriteTokens: 154, cacheWrite5mTokens: 0, cacheWrite1hTokens: 154 });
    expect(fromAnthropicUsage({ input_tokens: 4, cache_creation_input_tokens: 154 })).toMatchObject({ cacheWriteTokens: 154, cacheWrite5mTokens: null, cacheWrite1hTokens: null });
  });

  it("treats a non-number as missing", () => {
    // @ts-expect-error: the types say number, but real data can have the wrong type.
    expect(fromAnthropicUsage({ input_tokens: "10", output_tokens: null })).toMatchObject({ inputTokens: null, outputTokens: null });
  });
});
