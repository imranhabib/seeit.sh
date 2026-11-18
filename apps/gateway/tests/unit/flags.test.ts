import { describe, expect, it } from "vitest";
import { openLedger } from "../../src/db/ledger.ts";
import { createVersionCheck } from "../../src/flags.ts";

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
