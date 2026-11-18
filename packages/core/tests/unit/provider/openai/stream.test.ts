import { describe, expect, it } from "vitest";
import { before, fixture, run, runEvents } from "../helpers.ts";

const CODEX_153 = fixture("openai-codex-0.153.4.sse");
const CODEX_169 = fixture("openai-codex-desktop-0.169.0.sse");

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

  // Field from codex-rs/codex-api/src/sse/responses.rs (ResponseCompletedUsage) at
  // openai/codex@9537934ed6d5a6658fc77032b3290650765466a1. Our fixtures predate it.
  it("reads codex_rollout_budget_units when present, and null when missing", () => {
    const withUnits = CODEX_169.replace('"usage":{', '"usage":{"codex_rollout_budget_units":2.5,');
    expect(withUnits).not.toBe(CODEX_169);
    expect(run("openai-responses", withUnits).usage?.codexRolloutBudgetUnits).toBe(2.5);
    expect(run("openai-responses", CODEX_169).usage?.codexRolloutBudgetUnits).toBeNull();
  });

  it("has no usage when the stream is cut before response.completed", () => {
    const s = run("openai-responses", before(CODEX_169, "response.completed"));
    expect(s.final).toBe(false);
    expect(s.usage).toBeNull();
    expect(s.outputChars).toBe("pong".length);
  });
});

// Sources: OpenAI Node SDK stream event types, src/resources/responses/responses.ts at
// openai/openai-node@4517ca801b79a93ccc17826b0b63ba2313355307; Codex's parser,
// codex-rs/codex-api/src/sse/responses.rs at openai/codex@9537934ed6d5a6658fc77032b3290650765466a1.
describe("spec: OpenAI Responses output and errors", () => {
  const created = { type: "response.created", response: { model: "gpt-6.1-sol" } };

  it("counts only model-output deltas, and not empty ones", () => {
    const s = runEvents("openai-responses", [
      created,
      // Output of a shell command the server ran: tool output, not model output.
      { type: "response.shell_call_output_content.delta", item_id: "sh_1", output_index: 0, command_index: 0, delta: { stdout: "file.txt\n" } },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "" },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "pong" },
    ]);
    expect(s.timeToFirstTokenMs).toBe(40);
    expect(s.outputChars).toBe("pong".length);
  });

  it("records the model from response.created and from response.completed", () => {
    const s = runEvents("openai-responses", [created, { type: "response.completed", response: { model: "gpt-6.1-other", usage: { input_tokens: 10, output_tokens: 1 } } }]);
    expect(s).toMatchObject({ startModel: "gpt-6.1-sol", model: "gpt-6.1-other", fallback: false });
  });

  it("reads the error code from an error event and from response.failed", () => {
    expect(runEvents("openai-responses", [created, { type: "error", code: "server_error", message: "boom", param: null, sequence_number: 1 }]).errorType).toBe("server_error");
    expect(
      runEvents("openai-responses", [created, { type: "response.failed", response: { status: "failed", error: { code: "rate_limit_exceeded", message: "..." }, usage: null } }]).errorType,
    ).toBe("rate_limit_exceeded");
  });
});

// Drift detection (ADR 0005, layer 3; PLAN.md follow-up step 1).
describe("unknown events and usage fields", () => {
  it.each([
    ["0.153.4", CODEX_153],
    ["0.169.0 (desktop)", CODEX_169],
  ])("finds none in the Codex %s fixture", (_v, text) => {
    const s = run("openai-responses", text);
    expect(s.unknownEvents).toEqual({});
    expect(s.unknownUsageFields).toEqual([]);
  });

  it("counts OpenAI Responses event types and lists usage fields it does not know", () => {
    const extra = 'event: response.brand_new\ndata: {"type":"response.brand_new"}\n\n';
    const text = before(CODEX_169, "response.completed") + extra + CODEX_169.slice(CODEX_169.indexOf("event: response.completed\n")).replace('"usage":{', '"usage":{"new_counter":1,');
    const s = run("openai-responses", text);
    expect(s.unknownEvents).toEqual({ "response.brand_new": 1 });
    expect(s.unknownUsageFields).toEqual(["new_counter"]);
  });
});
