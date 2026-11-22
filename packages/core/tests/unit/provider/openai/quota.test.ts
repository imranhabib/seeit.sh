import { describe, expect, it } from "vitest";
import { quotaWindows } from "../../../../src/provider/openai/quota.ts";

describe("quotaWindows: codex", () => {
  // Header names as Codex 0.169.1 received them (Iris, 2026-11-18), and the
  // per-limit families from codex-rs/codex-api/src/rate_limits.rs.
  it("turns primary and secondary windows into rows, per limit family", () => {
    const rows = quotaWindows({
      "x-codex-primary-used-percent": "44",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "1794973200",
      "x-codex-primary-reset-after-seconds": "100",
      "x-codex-secondary-used-percent": "7.5",
      "x-codex-other-primary-used-percent": "3",
      "x-codex-plan-type": "plus",
    });
    expect(rows).toEqual([
      { window: "primary", usedPercent: 44, resetsAt: "2026-11-18T03:40:00.000Z", windowMinutes: 300, status: null },
      { window: "secondary", usedPercent: 7.5, resetsAt: null, windowMinutes: null, status: null },
      { window: "codex-other-primary", usedPercent: 3, resetsAt: null, windowMinutes: null, status: null },
    ]);
  });
});
