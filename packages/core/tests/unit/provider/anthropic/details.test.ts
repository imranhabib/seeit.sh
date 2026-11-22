import { describe, expect, it } from "vitest";
import { requestDetails, responseDetails, toolResults, toolUses } from "../../../../src/provider/anthropic/details.ts";

const bp = (ttl?: string) => ({ type: "ephemeral", ...(ttl ? { ttl } : {}) });

// Shapes from Claude Code 2.1.326 requests and responses (Iris, 2026-11-18).
describe("requestDetails: claude", () => {
  const body = {
    system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.326.f48; cc_entrypoint=sdk-cli;" }, { type: "text", text: "p", cache_control: bp("1h") }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: bp("1h") }] }],
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "medium" },
  };
  const headers = new Headers({
    "anthropic-beta": "claude-code-20250219,extended-cache-ttl-2025-04-11",
    "x-stainless-retry-count": "0",
    "x-claude-code-compaction": "manual",
  });

  it("reads the build, entrypoint, effort, thinking, retries, beta features, and compaction trigger", () => {
    expect(requestDetails(headers, body)).toEqual({
      harnessBuild: "2.1.326.f48",
      entrypoint: "sdk-cli",
      reasoningEffort: "medium",
      thinkingType: "adaptive",
      retryCount: 0,
      features: ["claude-code-20250219", "extended-cache-ttl-2025-04-11"],
      compactionTrigger: "manual",
      cacheTtl: "1h",
    });
  });

  it("says 5m when breakpoints set no ttl, and null when there are none", () => {
    expect(requestDetails(new Headers(), { system: [{ type: "text", text: "p", cache_control: bp() }] }).cacheTtl).toBe("5m");
    expect(requestDetails(new Headers(), { messages: [{ role: "user", content: "hi" }] })).toMatchObject({ cacheTtl: null, harnessBuild: null, features: null, retryCount: null });
  });
});

describe("responseDetails: claude", () => {
  it("reads the request ID, cache miss reason, context edits, iterations, tier, and region", () => {
    const iterations = [{ type: "message", input_tokens: 4, output_tokens: 54 }];
    const details = responseDetails(
      [
        {
          type: "message_start",
          message: {
            usage: { input_tokens: 4, service_tier: "standard", inference_geo: "global" },
            diagnostics: { cache_miss_reason: { type: "model_changed", cache_missed_input_tokens: 12000 } },
          },
        },
        { type: "message_delta", usage: { output_tokens: 54, iterations }, context_management: { applied_edits: [] } },
      ],
      new Headers({ "request-id": "req_011" }),
    );
    expect(details).toEqual({
      providerRequestId: "req_011",
      cacheMissReason: { type: "model_changed", cache_missed_input_tokens: 12000 },
      contextEdits: [],
      usageIterations: iterations,
      serviceTier: "standard",
      inferenceGeo: "global",
    });
  });

  it("leaves what is not sent as null (diagnostics: null in Iris runs)", () => {
    expect(responseDetails([{ type: "message_start", message: { diagnostics: null } }], new Headers())).toEqual({
      providerRequestId: null,
      cacheMissReason: null,
      contextEdits: null,
      usageIterations: null,
      serviceTier: null,
      inferenceGeo: null,
    });
  });
});

describe("toolUses: claude", () => {
  const block = (index: number, content_block: object, input?: object) => [
    { type: "content_block_start", index, content_block },
    ...(input ? [{ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input).slice(0, 5) } }, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input).slice(5) } }] : []),
    { type: "content_block_stop", index },
  ];

  it("labels built-in, skill, subagent, MCP, plugin, and server tools; reads only the listed inputs", () => {
    const uses = toolUses([
      ...block(0, { type: "text", text: "" }),
      ...block(1, { type: "tool_use", id: "tu1", name: "Bash" }, { command: "ls -la /secret" }),
      ...block(2, { type: "tool_use", id: "tu2", name: "Skill" }, { skill: "make-notes", args: "private" }),
      ...block(3, { type: "tool_use", id: "tu3", name: "Skill" }, { skill: "mattpocock-skills:tdd" }),
      ...block(4, { type: "tool_use", id: "tu4", name: "Agent" }, { subagent_type: "Explore", prompt: "private" }),
      ...block(5, { type: "tool_use", id: "tu5", name: "mcp__iris__echo" }, { text: "x" }),
      ...block(6, { type: "tool_use", id: "tu6", name: "mcp__plugin_browser-use_browser-use__browser_exec" }, {}),
      ...block(7, { type: "server_tool_use", id: "srv1", name: "web_search" }, { query: "q" }),
    ]);
    expect(uses).toEqual([
      { toolUseId: "tu1", kind: "builtin", name: "Bash", namespace: null, target: null, plugin: null },
      { toolUseId: "tu2", kind: "skill", name: "Skill", namespace: null, target: "make-notes", plugin: null },
      { toolUseId: "tu3", kind: "skill", name: "Skill", namespace: null, target: "mattpocock-skills:tdd", plugin: "mattpocock-skills" },
      { toolUseId: "tu4", kind: "agent", name: "Agent", namespace: null, target: "Explore", plugin: null },
      { toolUseId: "tu5", kind: "mcp", name: "mcp__iris__echo", namespace: null, target: "iris", plugin: null },
      { toolUseId: "tu6", kind: "mcp", name: "mcp__plugin_browser-use_browser-use__browser_exec", namespace: null, target: "browser-use", plugin: "browser-use" },
      { toolUseId: "srv1", kind: "server", name: "web_search", namespace: null, target: null, plugin: null },
    ]);
  });

  it("keeps a tool use whose input was cut off, without a target", () => {
    const uses = toolUses([
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "Skill" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"ski' } },
    ]);
    expect(uses).toEqual([{ toolUseId: "tu1", kind: "skill", name: "Skill", namespace: null, target: null, plugin: null }]);
  });
});

describe("toolResults: claude", () => {
  it("gives the size of every tool result in the request", () => {
    const results = toolResults({
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "abc" }] },
        { role: "assistant", content: [{ type: "text", text: "x" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: [{ type: "text", text: "hello" }] }, { type: "text", text: "hi" }] },
        { role: "user", content: "plain" },
      ],
    });
    expect(results).toEqual([
      { toolUseId: "tu1", resultChars: 3 },
      { toolUseId: "tu2", resultChars: 5 },
    ]);
  });
});
