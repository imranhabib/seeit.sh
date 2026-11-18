// One console line per call, plus a warning line when something drifted.

import type { CallRow } from "./db/schema.ts";

export function logCall(r: CallRow) {
  const tokens =
    r.inputTokens === null
      ? ""
      : ` in=${r.inputTokens} cache_read=${r.cacheReadTokens} cache_write=${r.cacheWriteTokens} out=${r.outputTokens}${r.tokensEstimated ? " (est.)" : ""}`;
  console.log(`[${r.harness}] ${r.method} ${r.path} -> ${r.httpStatus ?? "-"} ${r.completion} ${r.kind}${tokens} (${Math.round(r.timeToStreamEndMs ?? 0)} ms)`);
  // Drift is rare and worth noticing, so it gets its own line.
  const drift = [
    r.flags && r.flags !== "[]" ? `flags=${r.flags}` : "",
    r.unknownEvents && r.unknownEvents !== "{}" ? `unknown_events=${r.unknownEvents}` : "",
    r.unknownUsageFields && r.unknownUsageFields !== "[]" ? `unknown_usage_fields=${r.unknownUsageFields}` : "",
  ].filter(Boolean);
  if (drift.length) console.warn(`[${r.harness}] drift (${r.harnessVersion ?? "unknown version"}): ${drift.join(" ")}`);
}
