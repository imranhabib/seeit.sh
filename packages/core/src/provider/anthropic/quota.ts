// Plan-quota response headers from the Anthropic API (PLAN.md, Phase 2).

import type { QuotaWindow } from "../../records.ts";
import { isoFromUnix, numberFrom } from "../model.ts";

export const QUOTA_HEADERS = [/^anthropic-ratelimit-unified-/];

/**
 * One row per window (ADR 0009, quota_windows). A window is a name with a
 * `-utilization` header: anthropic-ratelimit-unified-<window>-utilization
 * (0-1), -reset (unix seconds), -status. Headers without a window
 * (-status, -reset, -overage-status, ...) stay in calls.quota only.
 */
export function quotaWindows(quota: Record<string, string> | null): QuotaWindow[] {
  if (!quota) return [];
  const rows: QuotaWindow[] = [];
  for (const name of Object.keys(quota)) {
    const window = name.match(/^anthropic-ratelimit-unified-(.+)-utilization$/)?.[1];
    if (!window) continue;
    const header = (suffix: string) => quota[`anthropic-ratelimit-unified-${window}-${suffix}`];
    const utilization = numberFrom(header("utilization"));
    rows.push({
      window,
      usedPercent: utilization === null ? null : Math.round(utilization * 100 * 1000) / 1000,
      resetsAt: isoFromUnix(numberFrom(header("reset"))),
      windowMinutes: null,
      status: header("status") ?? null,
    });
  }
  return rows;
}
