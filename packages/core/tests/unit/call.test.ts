import { describe, expect, it } from "vitest";
import { analyzeCall, type RecordedCall } from "../../src/call.ts";
import { fixture } from "./provider/helpers.ts";

const piecesOf = (text: string, size = 50): [number, number][] =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, i) => [Math.min(size, text.length - i * size), 100 + i * 10]);

const claudeTurn = JSON.stringify({ model: "claude-sonnet-5-5", tools: [{ name: "Read" }], messages: [{ role: "user", content: "hi" }] });

function recorded(extra: Partial<RecordedCall> = {}, body = fixture("anthropic-claude-2.1.322.sse")): RecordedCall {
  return {
    id: "c1",
    userId: "local",
    seq: 7,
    startedAt: "2026-11-18T00:00:00.000Z",
    harness: "claude",
    method: "POST",
    path: "/v1/messages?beta=true",
    turnId: "t1",
    request: {
      headers: { "user-agent": "claude-cli/2.1.322 (external, cli)", "x-claude-code-session-id": "s1", authorization: "[redacted, 20 chars]" },
      body: claudeTurn,
    },
    response: {
      status: 200,
      headers: { "content-type": "text/event-stream", "anthropic-ratelimit-unified-5h-utilization": "0.85", "request-id": "req_1" },
      body,
      pieces: piecesOf(body),
    },
    timeToResponseHeadersMs: 90,
    timeToFirstChunkMs: 100,
    timeToStreamEndMs: 900,
    clientAborted: false,
    readFailed: false,
    ...extra,
  };
}

describe("analyzeCall", () => {
  it("turns a complete Claude Code turn into ledger fields", () => {
    const { fields, stream, error } = analyzeCall(recorded());
    expect(error).toBeUndefined();
    expect(stream?.final).toBe(true);
    expect(fields).toMatchObject({
      id: "c1",
      harness: "claude",
      harnessVersion: "claude-cli/2.1.322",
      sessionId: "s1",
      turnId: "t1",
      kind: "turn",
      httpStatus: 200,
      completion: "complete",
      tokensEstimated: false,
      timeToResponseHeadersMs: 90,
      timeToFirstChunkMs: 100,
      timeToStreamEndMs: 900,
      toolsCount: 1,
      quota: { "anthropic-ratelimit-unified-5h-utilization": "0.85" },
      flags: [],
      unknownEvents: {},
      unknownUsageFields: [],
    });
    expect(fields.inputTokens).not.toBeNull();
    expect(fields.outputTokens).not.toBeNull();
    // From the piece times, not from when analysis ran.
    expect(fields.timeToFirstTokenMs).toBeGreaterThanOrEqual(100);
    expect(fields.timeToFirstTokenMs).toBeLessThan(900);
  });

  // Codex sends SSE with no content-type, and its turn ID in a header.
  it("reads a Codex stream with no content-type and keeps the Codex quota headers", () => {
    const body = fixture("openai-codex-0.153.4.sse");
    const call = recorded(
      {
        harness: "codex",
        path: "/responses",
        request: {
          headers: { "user-agent": "codex_exec/0.153.4", "x-codex-turn-metadata": JSON.stringify({ session_id: "s2", turn_id: "ct1", request_kind: "turn" }) },
          body: JSON.stringify({ model: "gpt-6-luna", input: [] }),
        },
        response: { status: 200, headers: { "x-codex-primary-used-percent": "44", "x-codex-plan-type": "plus" }, body, pieces: piecesOf(body) },
      },
      body,
    );
    const { fields } = analyzeCall(call);
    expect(fields).toMatchObject({ harness: "codex", sessionId: "s2", kind: "turn", completion: "complete", quota: { "x-codex-primary-used-percent": "44", "x-codex-plan-type": "plus" } });
    expect(fields.outputTokens).not.toBeNull();
  });

  it("estimates usage for a turn stream cut before its final event", () => {
    const full = fixture("anthropic-claude-2.1.322.sse");
    const cut = full.slice(0, full.indexOf("event: message_delta"));
    const { fields } = analyzeCall(recorded({ readFailed: true, response: { ...recorded().response, body: cut, pieces: piecesOf(cut) } }, cut));
    expect(fields.completion).toBe("upstream_dropped");
    expect(fields.tokensEstimated).toBe(true);
    expect(fields.inputTokens).toBeGreaterThan(0);
  });

  it("reads usage from a JSON body (Claude Code's quota probe)", () => {
    const body = JSON.stringify({ type: "message", usage: { input_tokens: 8, output_tokens: 1 } });
    const { fields } = analyzeCall(recorded({ response: { status: 200, headers: { "content-type": "application/json" }, body, pieces: [[body.length, 100]] } }, body));
    expect(fields).toMatchObject({ completion: "complete", inputTokens: 8, outputTokens: 1 });
  });

  it("records a HEAD connectivity check as complete, with no quota when upstream never answered", () => {
    const head = recorded({ method: "HEAD", path: "/", request: { headers: {}, body: null }, response: { status: 404, headers: {}, body: null, pieces: [] } });
    expect(analyzeCall(head).fields).toMatchObject({ kind: "connectivity", completion: "complete" });
    const failed = recorded({ response: { status: null, headers: {}, body: null, pieces: [] } });
    expect(analyzeCall(failed).fields).toMatchObject({ httpStatus: null, quota: null });
  });

  it("keeps the user and sequence number the gateway sent", () => {
    expect(analyzeCall(recorded()).fields).toMatchObject({ userId: "local", seq: 7 });
  });

  it("reads the detail columns and the records for the other ledger tables (ADR 0009)", () => {
    const { fields, records } = analyzeCall(recorded());
    expect(fields).toMatchObject({ providerRequestId: "req_1", requestKind: null, cacheMissReason: null });
    expect(records.quotaWindows).toEqual([{ window: "5h", usedPercent: 85, resetsAt: null, windowMinutes: null, status: null }]);
    expect(records.pieces.map((p) => p.path)).toEqual(["tools", "messages[0]", "fields"]);
    expect(records.contextParts.map((p) => p.category)).toEqual(["tool_definitions", "user_prompt"]);
    expect(records.modelCatalog).toEqual([]);
  });

  it("reads Codex turn metadata, attribution, tool uses, and tool results", () => {
    const completed = {
      type: "response.completed",
      response: {
        id: "resp_1",
        model: "gpt-6-luna",
        prompt_cache_retention: "24h",
        output: [],
        usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, attribution: { items: { msg_1: { input_tokens: 9, cached_tokens: 0, cache_write_tokens: 0, output_tokens: 0 } } } },
      },
    };
    const item = { type: "response.output_item.done", item: { type: "custom_tool_call", call_id: "call_9", name: "exec", input: "await tools.mcp__iris__echo({})" } };
    const sse = [{ type: "response.created", response: { id: "resp_1", model: "gpt-6-luna" } }, item, completed].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    const meta = { session_id: "s2", turn_id: "ct1", request_kind: "turn", window_number: 2, history_initialization: "new" };
    const input = [{ type: "message", role: "user", id: "msg_1", content: [{ type: "input_text", text: "hi" }] }, { type: "custom_tool_call_output", call_id: "call_8", output: "abc" }];
    const { fields, records } = analyzeCall(
      recorded({
        harness: "codex",
        path: "/responses",
        request: { headers: { "user-agent": "codex_exec/0.169.1", "x-codex-turn-metadata": JSON.stringify(meta) }, body: JSON.stringify({ model: "gpt-6-luna", input }) },
        response: { status: 200, headers: {}, body: sse, pieces: piecesOf(sse) },
      }),
    );
    expect(fields).toMatchObject({ providerRequestId: "resp_1", promptCacheRetention: "24h", requestKind: "turn", contextWindowNumber: 2, historyInitialization: "new" });
    expect(records.contextParts[0]).toMatchObject({ itemId: "msg_1", inputTokens: 9, tokensSource: "provider" });
    expect(records.toolUses.map((u) => [u.toolUseId, u.kind, u.target])).toEqual([["call_9", "builtin", null], ["call_9#1", "mcp", "iris"]]);
    expect(records.toolResults).toEqual([{ toolUseId: "call_8", resultChars: 3 }]);
  });

  it("reads the Codex model catalog from GET /models", () => {
    const body = JSON.stringify({ models: [{ slug: "gpt-6-luna", context_window: 272000 }] });
    const { records } = analyzeCall(
      recorded({
        harness: "codex",
        method: "GET",
        path: "/models?client_version=0.169.1",
        request: { headers: { "user-agent": "codex_exec/0.169.1" }, body: null },
        response: { status: 200, headers: { "content-type": "application/json" }, body, pieces: [[body.length, 100]] },
      }),
    );
    expect(records.modelCatalog).toMatchObject([{ model: "gpt-6-luna", contextWindow: 272000 }]);
    expect(records.pieces).toEqual([]);
  });
});
