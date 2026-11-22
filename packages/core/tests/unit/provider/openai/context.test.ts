import { describe, expect, it } from "vitest";
import { contextParts } from "../../../../src/provider/openai/context.ts";

const text = (t: string) => ({ type: "input_text", text: t });

// The layout of a Codex 0.169.1 request (PLAN.md, field inventory 1).
const body = {
  input: [
    { type: "additional_tools", id: "at_1", tools: [{ type: "namespace", name: "functions", tools: [] }] },
    { type: "message", role: "developer", id: "msg_base", content: [text("You are Codex, an agent.")] },
    {
      type: "message",
      role: "developer",
      id: "msg_dev",
      content: [text("<skills_instructions>\n..."), text("<permissions instructions>\n..."), text("<collaboration_mode>..."), text("<tools>\nmcp..."), text("<recommended_plugins>...")],
    },
    { type: "message", role: "developer", id: "msg_ma", content: [text("<multi_agent_role>...")] },
    { type: "message", role: "user", id: "msg_agents", content: [text("# AGENTS.md instructions for /p\n\n<INSTRUCTIONS>...")] },
    { type: "message", role: "user", id: "msg_env", content: [text("<environment_context>\n  <cwd>/p</cwd>\n</environment_context>")] },
    { type: "message", role: "user", id: "msg_sum", content: [text("Another language model started to solve this problem and produced a summary")] },
    { type: "reasoning", id: "rs_1", encrypted_content: "xxxx" },
    { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", input: "await tools.exec_command({})" },
    { type: "custom_tool_call_output", id: "ctco_1", call_id: "call_1", output: "out" },
    { type: "message", role: "assistant", id: "amsg_1", content: [{ type: "output_text", text: "from a subagent" }] },
    { type: "message", role: "assistant", id: "msg_a", content: [{ type: "output_text", text: "done" }] },
    // The newest user message has no id, so no attribution.
    { type: "message", role: "user", content: [text("What did we talk about?")] },
  ],
};

// usage.attribution.items: keyed by item ID, sorted by ID, not in input order.
const attribution = {
  amsg_1: { input_tokens: 4, cached_tokens: 4, cache_write_tokens: 0, output_tokens: 0 },
  at_1: { input_tokens: 5712, cached_tokens: 5712, cache_write_tokens: 0, output_tokens: 0 },
  msg_base: { input_tokens: 3456, cached_tokens: 3248, cache_write_tokens: 0, output_tokens: 0, content: [{ input_tokens: 3456, cached_tokens: 3248, cache_write_tokens: 0, output_tokens: 0 }] },
  msg_dev: {
    input_tokens: 1577,
    cached_tokens: 1577,
    cache_write_tokens: 0,
    output_tokens: 0,
    content: [487, 139, 199, 517, 235].map((n) => ({ input_tokens: n, cached_tokens: n, cache_write_tokens: 0, output_tokens: 0 })),
  },
  rs_1: { input_tokens: 30, cached_tokens: 0, cache_write_tokens: 0, output_tokens: 0 },
};

describe("contextParts: codex", () => {
  it("lists every input item (and each content part) in input order, with a category and a safe label", () => {
    const parts = contextParts(body, attribution);
    expect(parts.map((p) => [p.ordinal, p.itemId, p.part, p.role, p.category, p.label])).toEqual([
      [0, "at_1", null, null, "tool_definitions", "additional_tools"],
      [1, "msg_base", 0, "developer", "system_prompt", null],
      [2, "msg_dev", 0, "developer", "skills", "skills_instructions"],
      [3, "msg_dev", 1, "developer", "permissions", "permissions instructions"],
      [4, "msg_dev", 2, "developer", "collaboration", "collaboration_mode"],
      [5, "msg_dev", 3, "developer", "deferred_tools", "tools"],
      [6, "msg_dev", 4, "developer", "plugins", "recommended_plugins"],
      [7, "msg_ma", 0, "developer", "multi_agent", "multi_agent_role"],
      [8, "msg_agents", 0, "user", "instructions_project", "instructions:project"],
      [9, "msg_env", 0, "user", "environment", "environment_context"],
      [10, "msg_sum", 0, "user", "compaction_summary", null],
      [11, "rs_1", null, null, "reasoning", null],
      [12, "ctc_1", null, null, "tool_call", "tool:exec"],
      [13, "ctco_1", null, null, "tool_result", null],
      [14, "amsg_1", 0, "assistant", "subagent_message", null],
      [15, "msg_a", 0, "assistant", "assistant", null],
      [16, null, 0, "user", "user_prompt", null],
    ]);
    expect(parts.every((p) => p.section === "input" && p.breakpointTtl === null && p.chars > 0)).toBe(true);
  });

  it("maps attribution by item ID and content part, never by position", () => {
    const parts = contextParts(body, attribution);
    expect(parts[0]).toMatchObject({ inputTokens: 5712, cachedTokens: 5712, cacheWriteTokens: 0, tokensSource: "provider" });
    expect(parts[1]).toMatchObject({ inputTokens: 3456, cachedTokens: 3248, tokensSource: "provider" });
    expect(parts.slice(2, 7).map((p) => p.inputTokens)).toEqual([487, 139, 199, 517, 235]);
    expect(parts[11]).toMatchObject({ inputTokens: 30, cachedTokens: 0, tokensSource: "provider" });
    // An item with several parts but no per-part counts would be ambiguous; a
    // one-part item without them takes the item's counts.
    expect(parts[14]).toMatchObject({ inputTokens: 4, tokensSource: "provider" });
  });

  it("estimates the parts attribution does not cover, with the cache state unknown", () => {
    const parts = contextParts(body, attribution);
    expect(parts[16]).toMatchObject({ itemId: null, tokensSource: "estimated", cachedTokens: null, cacheWriteTokens: null });
    expect(parts[16]!.inputTokens).toBeGreaterThan(0);
    expect(contextParts(body, null).every((p) => p.tokensSource === "estimated")).toBe(true);
  });
});
