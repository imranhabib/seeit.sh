import { describe, expect, it } from "vitest";
import { quotaWindows } from "../../../../src/provider/anthropic/quota.ts";

describe("quotaWindows: claude", () => {
  // Header names and values as Claude Code 2.1.326 received them (Iris, 2026-11-18).
  it("turns each unified window into one row; utilization 0-1 becomes percent", () => {
    const rows = quotaWindows({
      "anthropic-ratelimit-unified-5h-utilization": "0.85",
      "anthropic-ratelimit-unified-5h-reset": "1794973200",
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-7d-utilization": "0.11",
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-reset": "1794973200",
      "anthropic-ratelimit-unified-overage-status": "rejected",
      "anthropic-ratelimit-unified-fallback-percentage": "0.5",
    });
    expect(rows).toEqual([
      { window: "5h", usedPercent: 85, resetsAt: "2026-11-18T03:40:00.000Z", windowMinutes: null, status: "allowed" },
      { window: "7d", usedPercent: 11, resetsAt: null, windowMinutes: null, status: null },
    ]);
  });

  it("is empty without quota headers and ignores values that are not numbers", () => {
    expect(quotaWindows(null)).toEqual([]);
    expect(quotaWindows({ "anthropic-ratelimit-unified-5h-utilization": "n/a" })).toEqual([
      { window: "5h", usedPercent: null, resetsAt: null, windowMinutes: null, status: null },
    ]);
  });
});
