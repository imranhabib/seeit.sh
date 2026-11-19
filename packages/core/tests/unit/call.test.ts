import { describe, expect, it } from "vitest";
import { analyzeCall, type RecordedCall } from "../../src/call.ts";
import { fixture } from "./provider/helpers.ts";

const piecesOf = (text: string, size = 50): [number, number][] =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, i) => [Math.min(size, text.length - i * size), 100 + i * 10]);

const claudeTurn = JSON.stringify({ model: "claude-sonnet-5-5", tools: [{ name: "Read" }], messages: [{ role: "user", content: "hi" }] });

function recorded(extra: Partial<RecordedCall> = {}, body = fixture("anthropic-claude-2.1.322.sse")): RecordedCall {
  return {
    id: "c1",
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
});
