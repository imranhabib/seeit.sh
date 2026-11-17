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
      outputTokens: 5,
      reasoningTokens: null,
      codexRolloutBudgetUnits: null,
      estimated: false,
    });
    expect(fromOpenAIUsage({ input_tokens: 100, input_tokens_details: { cached_tokens: 40 } })).toMatchObject({ inputTokens: 60, cacheReadTokens: 40, cacheWriteTokens: null });
    expect(fromOpenAIUsage({ output_tokens: 5 })).toMatchObject({ inputTokens: null, outputTokens: 5 });
  });

  it("treats a non-number as missing", () => {
    expect(fromAnthropicUsage({ input_tokens: "10", output_tokens: null })).toMatchObject({ inputTokens: null, outputTokens: null });
  });
});
