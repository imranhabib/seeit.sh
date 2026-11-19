// Reads what the ledger service stored for the calls the gateway recorded.
//
// Today Iris reads the ledger's PostgreSQL database directly. When the
// ledger's read API exists (PLAN.md, Phase 1C), only this file changes.
// Nothing else in Iris knows where calls are stored.

import type { Pool } from "pg";

/** One ledger row, with the columns Iris uses (snake_case column names; JSON values as text). */
export type CallRecord = {
  id: string;
  started_at: string;
  harness: string;
  harness_version: string | null;
  session_id: string | null;
  turn_id: string | null;
  agent_id: string | null;
  kind: string;
  method: string;
  path: string;
  http_status: number | null;
  completion: string;
  model: string | null;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  output_tokens: number | null;
  tokens_estimated: number;
  server_tool_use: string | null;
  flags: string | null;
  unknown_events: string | null;
  unknown_usage_fields: string | null;
};

/** Calls that started at or after `since` (ISO time), oldest first. */
export async function readCalls(db: Pool, since = ""): Promise<CallRecord[]> {
  const { rows } = await db.query("select * from calls where started_at >= $1 order by started_at", [since || "1970-01-01T00:00:00Z"]);
  // PostgreSQL returns dates and JSON values; Iris's checks were written for
  // the stored text form, so convert back.
  const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
  return rows.map((r) => ({
    ...r,
    started_at: (r.started_at as Date).toISOString(),
    tokens_estimated: r.tokens_estimated ? 1 : 0,
    server_tool_use: json(r.server_tool_use),
    flags: json(r.flags),
    unknown_events: json(r.unknown_events),
    unknown_usage_fields: json(r.unknown_usage_fields),
  })) as CallRecord[];
}

/**
 * The ledger stores a row after the gateway delivers the call, in the
 * background. Wait until at least `count` rows exist since `since`, or time out.
 */
export async function waitForCalls(db: Pool, since: string, count: number, timeoutMs = 15_000): Promise<CallRecord[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await readCalls(db, since);
    if (rows.length >= count || Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
