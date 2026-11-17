import { describe, expect, it } from "vitest";
import type { Observed } from "../src/chaos-proxy.ts";
import { checkScenario, type ScenarioEvidence } from "../src/check.ts";
import type { CallRecord } from "../src/results.ts";
import type { Scenario } from "../src/scenarios.ts";

const scenario = (extra: Partial<Scenario> = {}): Scenario => ({ id: "x", harness: "claude", about: "", steps: [{ prompt: "p" }], expect: { turns: 1 }, ...extra });

const row = (extra: Partial<CallRecord> = {}): CallRecord => ({
  id: "c",
  started_at: "2026-11-17T00:00:00.000Z",
  harness: "claude",
  harness_version: "claude-cli/2.1.326",
  session_id: "s1",
  turn_id: "t1",
  agent_id: null,
  kind: "turn",
  method: "POST",
  path: "/v1/messages?beta=true",
  http_status: 200,
  completion: "complete",
  model: "claude-opus-5-5",
  input_tokens: 10,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  output_tokens: 5,
  tokens_estimated: 0,
  server_tool_use: null,
  flags: "[]",
  unknown_events: "{}",
  unknown_usage_fields: "[]",
  ...extra,
});

const seen = (extra: Partial<Observed> = {}): Observed => ({ harness: "claude", method: "POST", path: "/v1/messages", kind: "turn", stream: true, final: true, markers: {}, ...extra });

const evidence = (extra: Partial<ScenarioEvidence> = {}): ScenarioEvidence => ({ exitCodes: [0], rows: [row()], observed: [seen()], faultHappened: false, ...extra });

describe("checkScenario", () => {
  it("passes a healthy scenario", () => {
    expect(checkScenario(scenario(), evidence())).toEqual([]);
    // The first call from a version without a fixture is flagged; that is expected.
    expect(checkScenario(scenario(), evidence({ rows: [row({ flags: '["untested_harness_version"]' })] }))).toEqual([]);
  });

  it("reports a failed step, but not the step Iris interrupted on purpose", () => {
    expect(checkScenario(scenario(), evidence({ exitCodes: [1] }))).toEqual(["step 1 exited with code 1"]);
    const interrupt = scenario({ fault: { action: "interrupt", afterTextDeltas: 5 }, expect: { turns: 1, incomplete: { client_aborted: 1 } } });
    const aborted = evidence({ exitCodes: [130], faultHappened: true, rows: [row({ completion: "client_aborted", tokens_estimated: 1 })], observed: [seen({ final: false })] });
    expect(checkScenario(interrupt, aborted)).toEqual([]);
  });

  it("reports a fault that never happened", () => {
    const cut = scenario({ fault: { action: "cut", afterTextDeltas: 40 }, expect: { turns: 1 } });
    expect(checkScenario(cut, evidence())).toEqual(["the cut never happened (no turn stream reached 40 text deltas)"]);
  });

  it("reports calls the gateway lost", () => {
    expect(checkScenario(scenario(), evidence({ observed: [seen(), seen()] }))).toContain("the gateway recorded 1 calls, the proxy saw 2");
  });

  it("reports drift and unexpected flags", () => {
    const problems = checkScenario(scenario(), evidence({ rows: [row({ flags: '["complete_without_usage"]', unknown_events: '{"brand_new":2}', unknown_usage_fields: '["new_counter"]' })] }));
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toMatch(/flags complete_without_usage[\s\S]*unknown events[\s\S]*unknown usage fields/);
  });

  it("checks usage and estimates on turn calls", () => {
    expect(checkScenario(scenario(), evidence({ rows: [row({ output_tokens: null })] })).join()).toContain("complete but no usage");
    expect(checkScenario(scenario(), evidence({ rows: [row({ tokens_estimated: 1 })] })).join()).toContain("complete but tokens are estimated");
    expect(checkScenario(scenario(), evidence({ rows: [row({ turn_id: null })] })).join()).toContain("turn call without a turn ID");
  });

  it("requires the ledger and the proxy to agree on unfinished streams", () => {
    // The proxy saw the stream end early, but the ledger calls it complete.
    const problems = checkScenario(scenario(), evidence({ observed: [seen({ final: false })] }));
    expect(problems).toEqual(["the proxy saw 1 unfinished stream(s), the ledger has 0 dropped or aborted call(s)"]);
  });

  it("checks the expected number of turns and incomplete calls", () => {
    const two = [row(), row({ turn_id: "t2" })];
    expect(checkScenario(scenario(), evidence({ rows: two, observed: [seen(), seen()] }))).toEqual(["expected 1 turn(s), got 2"]);
    const dropped = evidence({ rows: [row({ completion: "upstream_dropped", tokens_estimated: 1 })], observed: [seen({ final: false })] });
    expect(checkScenario(scenario(), dropped)).toEqual(["expected 0 upstream_dropped call(s), got 1"]);
    expect(checkScenario(scenario({ expect: { turns: 1, incomplete: { upstream_dropped: 1 } } }), dropped)).toEqual([]);
  });

  it("reports an upstream error, unless the scenario lists that request as a known failure", () => {
    // Codex's WebSocket attempt: the gateway cannot proxy it, upstream answers 405.
    // Seen live: the attempts come before the first turn, so there is no turn to link them to.
    const ws = row({ kind: "background", method: "GET", path: "/responses", http_status: 405, completion: "upstream_error", turn_id: null, input_tokens: null, output_tokens: null, started_at: "2026-11-16T23:59:59.000Z" });
    const e = evidence({ rows: [ws, row()], observed: [seen({ stream: false, final: false }), seen()] });
    expect(checkScenario(scenario(), e)).toEqual(["expected 0 upstream_error call(s), got 1"]);
    expect(checkScenario(scenario({ expect: { turns: 1, knownFailures: ["GET /responses"] } }), e)).toEqual([]);
  });

  it("requires proof that the scenario exercised its feature", () => {
    const search = scenario({ expect: { turns: 1, saw: ["item:web_search_call"] } });
    expect(checkScenario(search, evidence())).toEqual(["no call contained item:web_search_call: the scenario did not exercise its feature"]);
    expect(checkScenario(search, evidence({ observed: [seen({ markers: { "item:web_search_call": 1 } })] }))).toEqual([]);
  });

  it("checks the subagent rule", () => {
    const sub = scenario({ expect: { turns: 1, subagents: 1 } });
    expect(checkScenario(sub, evidence())).toEqual(["expected calls from at least 1 subagent(s), got 0"]);
    const rows = [row(), row({ agent_id: "a1" })];
    expect(checkScenario(sub, evidence({ rows, observed: [seen(), seen()] }))).toEqual([]);
    const split = [row(), row({ agent_id: "a1", turn_id: "t2" })];
    expect(checkScenario(sub, evidence({ rows: split, observed: [seen(), seen()] }))).toEqual(["expected 1 turn(s), got 2", "a subagent call is not in its parent's turn"]);
    // Two agents wanted, but both calls came from the same one.
    const two = scenario({ expect: { turns: 1, subagents: 2 } });
    const oneAgent = [row(), row({ agent_id: "a1" }), row({ agent_id: "a1" })];
    expect(checkScenario(two, evidence({ rows: oneAgent, observed: [seen(), seen(), seen()] }))).toEqual(["expected calls from at least 2 subagent(s), got 1"]);
    const twoAgents = [row(), row({ agent_id: "a1" }), row({ agent_id: "a2" })];
    expect(checkScenario(two, evidence({ rows: twoAgents, observed: [seen(), seen(), seen()] }))).toEqual([]);
  });

  it("reports a call with a session ID that is not linked to a turn", () => {
    const bg = row({ kind: "background", started_at: "2026-11-17T00:00:01.000Z", turn_id: null });
    expect(checkScenario(scenario(), evidence({ rows: [row(), bg], observed: [seen(), seen()] }))).toEqual([
      "POST /v1/messages (background, complete): has a session ID but no turn, although turn t1 was in progress",
    ]);
    // Before the session's first turn (a startup probe) there is nothing to link to.
    const early = row({ kind: "background", started_at: "2026-11-16T23:59:59.000Z", turn_id: null });
    expect(checkScenario(scenario(), evidence({ rows: [early, row()], observed: [seen(), seen()] }))).toEqual([]);
  });

  it("reports the user's own setup leaking into a request", () => {
    const leak = evidence({ observed: [seen({ markers: { "request:leak-home-skills": 1 } })] });
    expect(checkScenario(scenario(), leak)).toEqual(["isolation: leak-home-skills found in a request"]);
  });
});
