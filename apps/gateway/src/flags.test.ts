import { describe, expect, it } from "vitest";
import { openLedger } from "./db/ledger.ts";
import { callFlags, createVersionCheck } from "./flags.ts";

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

describe("createVersionCheck", () => {
  const row = (id: string, harnessVersion: string, flags: string | null) => ({
    id,
    startedAt: new Date().toISOString(),
    harness: "codex",
    harnessVersion,
    kind: "turn",
    method: "POST",
    path: "/responses",
    completion: "complete",
    tokensEstimated: false,
    flags,
  });

  it("flags the first checked call from an untested version once, and never a tested one", () => {
    const ledger = openLedger(":memory:");
    const isFirstUntested = createVersionCheck(ledger);
    expect(isFirstUntested("claude-cli/2.1.322")).toBe(false); // has a fixture
    expect(isFirstUntested(null)).toBe(false);
    expect(isFirstUntested("codex_exec/9.9.9")).toBe(true);
    expect(isFirstUntested("codex_exec/9.9.9")).toBe(false);
    ledger.close();
  });

  // Rows recorded before the checks existed have flags = null. A version seen
  // only in those rows was never flagged, so its first checked call must be.
  it("ignores rows recorded before the checks existed", async () => {
    const ledger = openLedger(":memory:");
    await ledger.record(row("old", "codex_exec/0.169.0", null), { request: null, response: null });
    expect(createVersionCheck(ledger)("codex_exec/0.169.0")).toBe(true);

    await ledger.record(row("checked", "codex_exec/0.169.0", "[]"), { request: null, response: null });
    expect(createVersionCheck(ledger)("codex_exec/0.169.0")).toBe(false); // a new gateway run, same ledger
    ledger.close();
  });
});
