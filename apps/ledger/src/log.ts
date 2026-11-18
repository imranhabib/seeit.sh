// One console line per stored call, plus a warning line when something drifted.

import type { CallFields } from "@seeit/core";

export function logCall(r: Omit<CallFields, "flags"> & { flags: string[] }) {
  const tokens =
    r.inputTokens === null
      ? ""
      : ` in=${r.inputTokens} cache_read=${r.cacheReadTokens} cache_write=${r.cacheWriteTokens} out=${r.outputTokens}${r.tokensEstimated ? " (est.)" : ""}`;
  console.log(`[${r.harness}] ${r.method} ${r.path} -> ${r.httpStatus ?? "-"} ${r.completion} ${r.kind}${tokens} (${Math.round(r.timeToStreamEndMs ?? 0)} ms)`);
  // Drift is rare and worth noticing, so it gets its own line.
  const drift = [
    r.flags.length ? `flags=${JSON.stringify(r.flags)}` : "",
    r.unknownEvents && Object.keys(r.unknownEvents).length ? `unknown_events=${JSON.stringify(r.unknownEvents)}` : "",
    r.unknownUsageFields?.length ? `unknown_usage_fields=${JSON.stringify(r.unknownUsageFields)}` : "",
  ].filter(Boolean);
  if (drift.length) console.warn(`[${r.harness}] drift (${r.harnessVersion ?? "unknown version"}): ${drift.join(" ")}`);
}
