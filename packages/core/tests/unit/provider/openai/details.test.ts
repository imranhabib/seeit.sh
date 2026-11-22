import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { modelCatalog, requestDetails, responseDetails, toolResults, toolUses } from "../../../../src/provider/openai/details.ts";

// Shapes from Codex 0.169.1 requests and responses (Iris, 2026-11-18).
describe("requestDetails: codex", () => {
  it("reads the turn metadata, effort, and beta features", () => {
    const meta = {
      request_kind: "compaction",
      window_number: 1,
      history_initialization: "cold_resume",
      turn_started_at_unix_ms: 1794973200123,
      compaction: { trigger: "auto", reason: "context_limit", implementation: "responses", phase: "pre_turn", strategy: "memento" },
    };
    const details = requestDetails(new Headers({ "x-codex-beta-features": "remote_compaction_v2" }), { reasoning: { effort: "medium" } }, meta);
    expect(details).toEqual({
      requestKind: "compaction",
      contextWindowNumber: 1,
      historyInitialization: "cold_resume",
      harnessTurnStartedAt: "2026-11-18T03:40:00.123Z",
      compactionTrigger: "auto",
      compactionReason: "context_limit",
      compactionPhase: "pre_turn",
      compactionStrategy: "memento",
      reasoningEffort: "medium",
      features: ["remote_compaction_v2"],
    });
  });

  it("is all null without metadata", () => {
    expect(Object.values(requestDetails(new Headers(), {}, {})).every((v) => v === null)).toBe(true);
  });
});

describe("responseDetails: codex", () => {
  it("reads the response ID, cache retention, tier, and cache writes by lifetime", () => {
    const response = {
      id: "resp_0c9",
      prompt_cache_retention: "24h",
      service_tier: "default",
      usage: { input_tokens_details: { cached_tokens: 10, cache_write_tokens: 3, cache_write_tokens_details: { ttl_30m_tokens: 1, ttl_12h_tokens: 2 } } },
    };
    expect(responseDetails([{ type: "response.created", response: { id: "resp_0c9" } }, { type: "response.completed", response }])).toEqual({
      providerRequestId: "resp_0c9",
      promptCacheRetention: "24h",
      serviceTier: "default",
      cacheWrite30mTokens: 1,
      cacheWrite12hTokens: 2,
    });
  });

  it("keeps the response ID from response.created when the stream was cut", () => {
    expect(responseDetails([{ type: "response.created", response: { id: "resp_1" } }]).providerRequestId).toBe("resp_1");
  });
});

describe("toolUses: codex", () => {
  const done = (item: object) => ({ type: "response.output_item.done", item });

  it("reads each tools.<name>( call in exec code, plus exec itself; namespaced calls; web search", () => {
    const code = "const a = await tools.exec_command({cmd: 'ls'});\nawait tools.mcp__iris__echo({text: a});\nawait tools.exec_command({});";
    const uses = toolUses([
      done({ type: "message", id: "msg_1" }),
      done({ type: "custom_tool_call", call_id: "call_1", name: "exec", input: code }),
      done({ type: "function_call", call_id: "call_2", name: "spawn_agent", namespace: "collaboration", arguments: "{\"message\":\"private\"}" }),
      done({ type: "function_call", call_id: "call_3", name: "mcp__plugin_docs_search__find", arguments: "{}" }),
      done({ type: "web_search_call", id: "ws_1" }),
    ]);
    expect(uses).toEqual([
      { toolUseId: "call_1", kind: "builtin", name: "exec", namespace: null, target: null, plugin: null },
      { toolUseId: "call_1#1", kind: "builtin", name: "exec_command", namespace: null, target: null, plugin: null },
      { toolUseId: "call_1#2", kind: "mcp", name: "mcp__iris__echo", namespace: null, target: "iris", plugin: null },
      { toolUseId: "call_1#3", kind: "builtin", name: "exec_command", namespace: null, target: null, plugin: null },
      { toolUseId: "call_2", kind: "agent", name: "spawn_agent", namespace: "collaboration", target: null, plugin: null },
      { toolUseId: "call_3", kind: "mcp", name: "mcp__plugin_docs_search__find", namespace: null, target: "search", plugin: "docs" },
      { toolUseId: "ws_1", kind: "server", name: "web_search", namespace: null, target: null, plugin: null },
    ]);
  });
});

describe("toolResults: codex", () => {
  it("gives the size of each tool output in the request", () => {
    expect(
      toolResults({
        input: [
          { type: "function_call_output", call_id: "call_2", output: "abcd" },
          { type: "custom_tool_call_output", call_id: "call_1", output: [{ type: "input_text", text: "hello" }] },
          { type: "message", role: "user", content: [] },
        ],
      }),
    ).toEqual([
      { toolUseId: "call_2", resultChars: 4 },
      { toolUseId: "call_1", resultChars: 5 },
    ]);
  });
});

describe("modelCatalog", () => {
  it("reads the compaction and truncation settings of each model", () => {
    const rows = modelCatalog(
      JSON.stringify({
        models: [
          {
            slug: "gpt-6.2-sol",
            context_window: 500000,
            max_context_window: 872000,
            auto_compact_token_limit: null,
            comp_hash: "3000",
            truncation_policy: { mode: "tokens", limit: 10000 },
            tool_mode: "code_mode_only",
            base_instructions: "You are Codex.",
          },
          { display_name: "no slug" },
        ],
      }),
    );
    expect(rows).toEqual([
      {
        model: "gpt-6.2-sol",
        contextWindow: 500000,
        maxContextWindow: 872000,
        autoCompactTokenLimit: null,
        compHash: "3000",
        truncationMode: "tokens",
        truncationLimit: 10000,
        toolMode: "code_mode_only",
        baseInstructionsChars: 14,
        baseInstructionsSha256: createHash("sha256").update("You are Codex.").digest("hex"),
      },
    ]);
  });

  it("is empty for a body that is not a catalog", () => {
    expect(modelCatalog("oops")).toEqual([]);
    expect(modelCatalog(null)).toEqual([]);
  });
});
