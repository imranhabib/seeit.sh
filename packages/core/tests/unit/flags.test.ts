import { describe, expect, it } from "vitest";
import { callFlags } from "../../src/flags.ts";

// A complete turn with full usage: no flags.
const ok = {
  kind: "turn",
  completion: "complete",
  turnId: "t1",
  inputTokens: 10,
  outputTokens: 2,
  tokensEstimated: false,
};

describe("callFlags", () => {
  it("has no flags for a normal complete turn", () => {
    expect(callFlags(ok)).toEqual([]);
  });

  it("flags a complete turn without usage", () => {
    expect(callFlags({ ...ok, inputTokens: null, outputTokens: null })).toEqual(["complete_without_usage"]);
    expect(callFlags({ ...ok, outputTokens: null })).toEqual(["complete_without_usage"]);
  });

  it("flags a turn without a turn ID", () => {
    expect(callFlags({ ...ok, turnId: null })).toEqual(["turn_without_turn_id"]);
  });

  it("flags estimated tokens on a complete call", () => {
    expect(callFlags({ ...ok, tokensEstimated: true })).toEqual(["estimated_on_complete"]);
  });

  it("does not flag what is expected for other kinds and completions", () => {
    // Background and connectivity calls have no turn and often no usage.
    expect(callFlags({ ...ok, kind: "background", turnId: null, inputTokens: null, outputTokens: null })).toEqual([]);
    expect(callFlags({ ...ok, kind: "connectivity", turnId: null, inputTokens: null, outputTokens: null })).toEqual([]);
    // A cut turn is estimated on purpose.
    expect(callFlags({ ...ok, completion: "client_aborted", tokensEstimated: true })).toEqual([]);
  });
});

// What the stream itself showed (StreamSummary fields). A normal stream: no flags.
const stream = {
  startModel: "claude-opus-5-5",
  model: "claude-opus-5-5",
  fallback: false,
  startInputTokens: 10,
  serverToolUse: null,
  serverToolSeen: false,
};

describe("callFlags: stream rules (PLAN.md follow-up step 2)", () => {
  it("has no flags for a normal stream", () => {
    expect(callFlags(ok, stream)).toEqual([]);
  });

  it("flags a model change that no fallback explains", () => {
    expect(callFlags(ok, { ...stream, model: "claude-opus-4-8" })).toEqual(["model_changed_without_fallback"]);
  });

  // The top-level usage covers only the serving model; earlier attempts are
  // billed too but only listed in usage.iterations (refusals-and-fallback docs).
  it("flags a fallback, whose usage leaves out the declined attempts", () => {
    // A different model also explains a different input count, so only one flag.
    expect(callFlags(ok, { ...stream, model: "claude-opus-4-8", fallback: true, startInputTokens: 535 })).toEqual(["fallback_usage_partial"]);
  });

  it("flags input that changed during the stream with no server tool", () => {
    expect(callFlags(ok, { ...stream, startInputTokens: 4 })).toEqual(["input_changed_without_server_tool"]);
    expect(callFlags(ok, { ...stream, startInputTokens: 4, serverToolSeen: true })).toEqual([]);
    expect(callFlags(ok, { ...stream, startInputTokens: 4, serverToolUse: { web_search_requests: 1 } })).toEqual([]);
  });

  it("checks input change only on complete calls, where the final count is known", () => {
    expect(callFlags({ ...ok, completion: "client_aborted", tokensEstimated: true }, { ...stream, startInputTokens: 4 })).toEqual([]);
  });

  it("skips rules whose data is missing (Codex has no start input count)", () => {
    expect(callFlags(ok, { ...stream, startModel: null, startInputTokens: null })).toEqual([]);
  });
});
