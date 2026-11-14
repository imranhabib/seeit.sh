import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decideCompletion } from "./completion.ts";
import { createSseParser } from "./sse.ts";
import { createInterpreter, type Provider, type StreamSummary } from "./stream.ts";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const CLAUDE = fixture("anthropic-claude-2.1.322.sse");
const CODEX_153 = fixture("openai-codex-0.153.4.sse");
const CODEX_169 = fixture("openai-codex-desktop-0.169.0.sse");

/** Feed text in fixed-size chunks; each chunk "arrives" 10 ms after the previous one. */
function run(provider: Provider, text: string, chunkSize = 37): StreamSummary {
  const parser = createSseParser();
  const interpreter = createInterpreter(provider);
  let atMs = 0;
  for (let i = 0; i < text.length; i += chunkSize) {
    atMs += 10;
    for (const e of parser.push(text.slice(i, i + chunkSize))) interpreter.onEvent(e, atMs);
  }
  for (const e of parser.flush()) interpreter.onEvent(e, atMs);
  return interpreter.summary();
}

/** The fixture text up to (not including) the first event of this type. */
const before = (text: string, eventType: string) => text.slice(0, text.indexOf(`event: ${eventType}\n`));

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
      outputTokens: 37,
      reasoningTokens: 0,
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

describe("openai responses interpreter", () => {
  it.each([
    ["0.153.4", CODEX_153, { inputTokens: 101591 - 3712, cacheReadTokens: 3712, outputTokens: 5 }],
    ["0.169.0 (desktop)", CODEX_169, { inputTokens: 20065, cacheReadTokens: 0, outputTokens: 5 }],
  ])("reads usage from Codex %s, converting input to exclude cached tokens", (_v, text, usage) => {
    const s = run("openai-responses", text);
    expect(s.model).toBe("gpt-6.1-sol");
    expect(s.final).toBe(true);
    expect(s.usage).toMatchObject({ ...usage, cacheWriteTokens: 0, estimated: false });
    expect(s.timeToFirstTokenMs).toBeGreaterThan(0);
  });

  it("has no usage when the stream is cut before response.completed", () => {
    const s = run("openai-responses", before(CODEX_169, "response.completed"));
    expect(s.final).toBe(false);
    expect(s.usage).toBeNull();
    expect(s.outputChars).toBe("pong".length);
  });
});

describe("decideCompletion", () => {
  const base = { status: 200, isStream: true, final: false, errorType: null, clientAborted: false, readFailed: false, gatewayFailed: false };

  it("is complete when the final event arrived, even if the connection then closed (Codex)", () => {
    expect(decideCompletion({ ...base, final: true, clientAborted: true, readFailed: true })).toBe("complete");
  });
  it("is upstream_error for an error event or an HTTP error", () => {
    expect(decideCompletion({ ...base, errorType: "overloaded_error" })).toBe("upstream_error");
    expect(decideCompletion({ ...base, status: 429, isStream: false })).toBe("upstream_error");
  });
  it("is client_aborted when the harness left before the final event", () => {
    expect(decideCompletion({ ...base, clientAborted: true, readFailed: true })).toBe("client_aborted");
  });
  it("is upstream_dropped when upstream failed or the stream ended early", () => {
    expect(decideCompletion({ ...base, readFailed: true })).toBe("upstream_dropped");
    expect(decideCompletion({ ...base })).toBe("upstream_dropped");
    expect(decideCompletion({ ...base, status: null })).toBe("upstream_dropped");
  });
  it("is complete for a non-streaming body read to the end", () => {
    expect(decideCompletion({ ...base, isStream: false })).toBe("complete");
  });
  it("is gateway_error when the gateway itself failed", () => {
    expect(decideCompletion({ ...base, final: true, gatewayFailed: true })).toBe("gateway_error");
  });
});
