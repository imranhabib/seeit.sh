// Plan-quota response headers from the ChatGPT backend, as Codex receives them
// (PLAN.md, Phase 2).

import type { QuotaWindow } from "../../records.ts";
import { isoFromUnix, numberFrom } from "../model.ts";

// Codex header names follow codex-rs/codex-api/src/rate_limits.rs. Besides
// the default "codex" family, the server can send one family per metered
// limit, named after the limit ID: x-<limit_id>-primary-used-percent, ...
// (limit "codex_other" -> x-codex-other-...). The server also sends window
// headers the Codex client does not read (x-codex-primary-reset-after-seconds,
// x-codex-primary-over-secondary-limit-percent, seen live 2026-11-16), so any
// suffix after -primary- / -secondary- is kept. Every pattern needs a quota
// word, so unrelated x-... headers (request IDs, account IDs) are not stored.
export const QUOTA_HEADERS = [
  /^x-[a-z0-9-]+-(primary|secondary)-[a-z0-9-]+$/,
  /^x-[a-z0-9-]+-limit-name$/,
  /^x-codex-credits-(has-credits|unlimited|balance)$/,
  /^x-codex-(plan-type|active-limit|rate-limit-reached-type|promo-message)$/,
];

/**
 * One row per window (ADR 0009, quota_windows): x-<family>-<primary|secondary>-
 * used-percent (0-100), -reset-at (unix seconds), -window-minutes. The default
 * family "codex" gives "primary" and "secondary"; another limit family keeps
 * its name ("codex-other-primary").
 */
export function quotaWindows(quota: Record<string, string> | null): QuotaWindow[] {
  if (!quota) return [];
  const rows: QuotaWindow[] = [];
  for (const name of Object.keys(quota)) {
    const match = name.match(/^x-([a-z0-9-]+)-(primary|secondary)-used-percent$/);
    if (!match) continue;
    const prefix = `x-${match[1]}-${match[2]}`;
    rows.push({
      window: match[1] === "codex" ? match[2]! : `${match[1]}-${match[2]}`,
      usedPercent: numberFrom(quota[name]),
      resetsAt: isoFromUnix(numberFrom(quota[`${prefix}-reset-at`])),
      windowMinutes: numberFrom(quota[`${prefix}-window-minutes`]),
      status: null,
    });
  }
  return rows;
}
