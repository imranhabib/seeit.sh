import { describe, expect, it } from "vitest";
import { before, fixture, run, runEvents } from "../helpers.ts";

const CLAUDE = fixture("anthropic-claude-2.1.322.sse");

describe("anthropic interpreter", () => {
  it("reads model, final usage, and first token from a complete stream", () => {
    const s = run("anthropic", CLAUDE);
    expect(s.model).toBe("claude-opus-5-5");
    expect(s.final).toBe(true);
    expect(s.errorType).toBeNull();
    // message_delta's totals replace message_start's placeholder output count (7 -> 37).
    expect(s.usage).toEqual({
      inputTokens: 4,
      cacheReadTokens: 46377,
      cacheWriteTokens: 154,
      cacheWrite5mTokens: 0, // from message_start's cache_creation, kept when message_delta omits it
      cacheWrite1hTokens: 154,
      outputTokens: 37,
      reasoningTokens: 0,
      codexRolloutBudgetUnits: null,
      estimated: false,
    });
    expect(s.timeToFirstTokenMs).toBeGreaterThan(0);
    expect(s.outputChars).toBeGreaterThan(50);
  });

  it.each([1, 5, 64, 1000])("gives the same result with %i-char chunks", (size) => {
    expect(run("anthropic", CLAUDE, size)).toMatchObject({ final: true, usage: { outputTokens: 37 } });
  });

  it("estimates output tokens when the stream is cut between events", () => {
    const s = run("anthropic", before(CLAUDE, "message_delta"));
    expect(s.final).toBe(false);
    expect(s.usage).toMatchObject({ inputTokens: 4, cacheReadTokens: 46377, estimated: true });
    expect(s.usage!.outputTokens).toBe(Math.ceil(s.outputChars / 4));
  });

  it("keeps the partial text when the stream is cut in the middle of an event", () => {
    const full = run("anthropic", CLAUDE);
    const cut = run("anthropic", CLAUDE.slice(0, CLAUDE.lastIndexOf('"text_delta"') + 30));
    expect(cut.final).toBe(false);
    expect(cut.usage!.estimated).toBe(true);
    expect(cut.outputChars).toBeGreaterThan(0);
    expect(cut.outputChars).toBeLessThan(full.outputChars);
  });

  it("records an error event sent mid-stream", () => {
    const error = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
    const s = run("anthropic", before(CLAUDE, "message_delta") + error);
    expect(s.errorType).toBe("overloaded_error");
    expect(s.final).toBe(false);
  });
});

const textDelta = (index: number, text: string) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
const blockStart = (index: number, content_block: object) => ({ type: "content_block_start", index, content_block });
const blockStop = (index: number) => ({ type: "content_block_stop", index });
const messageStart = (model: string, usage: object) => ({ type: "message_start", message: { model, content: [], usage } });

// Source: https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback
// ("Server-side fallback": "What the response contains" and "Streaming").
describe("spec: server-side fallback (gap 1)", () => {
  const fallbackBlock = { type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" }, trigger: { type: "refusal", category: "cyber" } };
  const midOutput = [
    messageStart("claude-fable-5", { input_tokens: 535, output_tokens: 1 }),
    blockStart(0, { type: "text", text: "" }),
    textDelta(0, "Partial answer"),
    blockStop(0),
    blockStart(1, fallbackBlock), // arrives whole: start + stop, no deltas
    blockStop(1),
    blockStart(2, { type: "text", text: "" }),
    textDelta(2, "Hi! How can I help you today?"),
    blockStop(2),
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: {
        input_tokens: 412,
        output_tokens: 264,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        iterations: [
          { type: "message", model: "claude-fable-5", input_tokens: 535, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 412, output_tokens: 264, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        ],
      },
    },
    { type: "message_stop" },
  ];

  it("takes the serving model from the fallback, not from message_start", () => {
    const s = runEvents("anthropic", midOutput);
    expect(s).toMatchObject({ startModel: "claude-fable-5", model: "claude-opus-4-8", fallback: true, final: true });
    // Top-level usage describes only the serving attempt (the docs: "Tokens from different models are never summed").
    expect(s.usage).toMatchObject({ inputTokens: 412, outputTokens: 264 });
  });

  it("knows the serving model from the fallback block even if the stream is cut before message_delta", () => {
    const s = runEvents("anthropic", midOutput.slice(0, 8));
    expect(s).toMatchObject({ model: "claude-opus-4-8", fallback: true, final: false });
  });

  it("has no fallback for a normal stream", () => {
    expect(run("anthropic", CLAUDE)).toMatchObject({ startModel: "claude-opus-5-5", model: "claude-opus-5-5", fallback: false });
  });
});

// Source: https://platform.claude.com/docs/en/build-with-claude/streaming
// ("Streaming request with web search tool use"; result content shortened).
describe("spec: server tools change input mid-stream (gaps 2 and 3)", () => {
  const webSearch = [
    messageStart("claude-opus-5-5", { input_tokens: 2679, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 }),
    blockStart(0, { type: "text", text: "" }),
    textDelta(0, "I'll check"),
    blockStop(0),
    blockStart(1, { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} }),
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query": "weather NYC today"}' } },
    blockStop(1),
    blockStart(2, { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", title: "Weather in New York City", url: "https://example.com", encrypted_content: "x".repeat(500) }] }),
    blockStop(2),
    blockStart(3, { type: "text", text: "" }),
    textDelta(3, "Here's the current weather"),
    blockStop(3),
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 10682, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 510, server_tool_use: { web_search_requests: 1 } },
    },
    { type: "message_stop" },
  ];

  it("takes the final input count and keeps the server tool counts", () => {
    const s = runEvents("anthropic", webSearch);
    expect(s.startInputTokens).toBe(2679);
    expect(s.usage).toMatchObject({ inputTokens: 10682, outputTokens: 510, estimated: false });
    expect(s.serverToolUse).toEqual({ web_search_requests: 1 });
    expect(s.serverToolSeen).toBe(true);
  });

  // MCP connector tools also run on the server (BetaMCPToolUseBlock in @anthropic-ai/sdk 1.4.0).
  it("treats an MCP connector tool block as a server tool", () => {
    const s = runEvents("anthropic", [
      messageStart("claude-opus-5-5", { input_tokens: 10, output_tokens: 1 }),
      blockStart(0, { type: "mcp_tool_use", id: "mcptoolu_1", name: "search", server_name: "docs", input: {} }),
    ]);
    expect(s.serverToolSeen).toBe(true);
  });

  it("does not count search results as model output (they become input)", () => {
    const s = runEvents("anthropic", webSearch);
    const modelText = "I'll check" + '{"query": "weather NYC today"}' + "Here's the current weather";
    expect(s.outputChars).toBe(modelText.length);
  });

  it("marks a stream cut after a search as estimated, with the low first input count", () => {
    const s = runEvents("anthropic", webSearch.slice(0, 11));
    expect(s.final).toBe(false);
    expect(s.serverToolSeen).toBe(true);
    expect(s.usage).toMatchObject({ inputTokens: 2679, estimated: true });
  });
});

// Source: https://platform.claude.com/docs/en/build-with-claude/streaming ("Event types", "Thinking delta").
describe("spec: first token (gaps 3 and 4)", () => {
  it("counts a redacted_thinking block, which arrives whole, as the first output", () => {
    const s = runEvents("anthropic", [
      messageStart("claude-opus-5-5", { input_tokens: 10, output_tokens: 1 }),
      blockStart(0, { type: "redacted_thinking", data: "EmwKAhgBEgy3va3pzix/LafPsn4a" }),
      blockStop(0),
      blockStart(1, { type: "text", text: "" }),
      textDelta(1, "Answer"),
    ]);
    expect(s.timeToFirstTokenMs).toBe(20);
    // Encrypted data is not text the model wrote, so it is not counted as output characters.
    expect(s.outputChars).toBe("Answer".length);
  });

  it('ignores the empty thinking delta and the signature with display: "omitted"', () => {
    const s = runEvents("anthropic", [
      messageStart("claude-opus-5-5", { input_tokens: 10, output_tokens: 1 }),
      blockStart(0, { type: "thinking", thinking: "", signature: "" }),
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds" } },
      blockStop(0),
      blockStart(1, { type: "text", text: "" }),
      textDelta(1, "Answer"),
    ]);
    expect(s.timeToFirstTokenMs).toBe(70);
  });

  it("ignores an empty input_json_delta (sent first for every tool call)", () => {
    const s = runEvents("anthropic", [
      messageStart("claude-opus-5-5", { input_tokens: 10, output_tokens: 1 }),
      blockStart(0, { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} }),
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"location"' } },
    ]);
    expect(s.timeToFirstTokenMs).toBe(40);
  });
});

// Source: https://platform.claude.com/docs/en/build-with-claude/streaming
// ("One or more message_delta events"; "token counts ... are cumulative").
describe("spec: several message_delta events", () => {
  it("keeps the last cumulative counts and earlier fields a later delta omits", () => {
    const s = runEvents("anthropic", [
      messageStart("claude-opus-5-5", { input_tokens: 10, cache_read_input_tokens: 900, output_tokens: 1 }),
      textDelta(0, "Hello"),
      { type: "message_delta", delta: {}, usage: { output_tokens: 5 } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } },
      { type: "message_stop" },
    ]);
    expect(s.usage).toMatchObject({ inputTokens: 10, cacheReadTokens: 900, outputTokens: 12, estimated: false });
  });
});

// Drift detection (ADR 0005, layer 3; PLAN.md follow-up step 1).
describe("unknown events and usage fields", () => {
  it("finds none in the anthropic fixture", () => {
    const s = run("anthropic", CLAUDE);
    expect(s.unknownEvents).toEqual({});
    expect(s.unknownUsageFields).toEqual([]);
  });

  it("counts Anthropic event types and lists usage fields it does not know", () => {
    const extra =
      'event: brand_new\ndata: {"type":"brand_new"}\n\n' +
      'event: brand_new\ndata: {"type":"brand_new"}\n\n' +
      // fallback_credit is documented (BetaUsage in @anthropic-ai/sdk 1.4.0) and ignored on purpose.
      'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":40,"new_counter":3,"fallback_credit":null}}\n\n';
    const s = run("anthropic", before(CLAUDE, "message_stop") + extra);
    expect(s.unknownEvents).toEqual({ brand_new: 2 });
    expect(s.unknownUsageFields).toEqual(["new_counter"]);
  });

  // A new block or delta type can carry output the interpreter does not count,
  // so it is reported like an unknown event. Known types: the content_block
  // and delta unions in @anthropic-ai/sdk 1.4.0 (BetaRawContentBlockStartEvent,
  // BetaRawContentBlockDelta).
  it("counts Anthropic block and delta types it does not know", () => {
    const s = runEvents("anthropic", [
      messageStart("claude-opus-5-5", { input_tokens: 10, output_tokens: 1 }),
      blockStart(0, { type: "hologram", data: "..." }),
      { type: "content_block_delta", index: 0, delta: { type: "hologram_delta", frames: "..." } },
      { type: "content_block_delta", index: 0, delta: { type: "hologram_delta", frames: "..." } },
      blockStop(0),
      // Known and ignored on purpose: seen live in web search answers.
      blockStart(1, { type: "text", text: "" }),
      { type: "content_block_delta", index: 1, delta: { type: "citations_delta", citation: { type: "web_search_result_location" } } },
    ]);
    expect(s.unknownEvents).toEqual({ "content_block_start:hologram": 1, "content_block_delta:hologram_delta": 2 });
    // An unknown delta is not counted as output.
    expect(s.timeToFirstTokenMs).toBeNull();
  });

  // Server-side compaction: the summary is text the model wrote (BetaCompactionContentBlockDelta).
  it("counts a compaction delta's summary as output", () => {
    const s = runEvents("anthropic", [
      messageStart("claude-opus-5-5", { input_tokens: 10, output_tokens: 1 }),
      blockStart(0, { type: "compaction", content: null }),
      { type: "content_block_delta", index: 0, delta: { type: "compaction_delta", content: "Summary so far." } },
    ]);
    expect(s.outputChars).toBe("Summary so far.".length);
    expect(s.unknownEvents).toEqual({});
  });
});
