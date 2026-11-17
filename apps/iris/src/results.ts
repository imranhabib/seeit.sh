// Reads what the gateway recorded.
//
// Today that is the gateway's SQLite ledger. When the ledger service exists
// (PLAN.md, Phase 1C), only this file changes: it will call the ledger's read
// API instead. Nothing else in Iris knows where calls are stored.

import Database from "better-sqlite3";

/** One ledger row, with the columns Iris uses (snake_case, as stored). */
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
export function readCalls(dbPath: string, since = ""): CallRecord[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("select * from calls where started_at >= ? order by started_at").all(since) as CallRecord[];
  } finally {
    db.close();
  }
}

/**
 * The gateway writes a row after each response ends, in the background.
 * Wait until at least `count` rows exist since `since`, or time out.
 */
export async function waitForCalls(dbPath: string, since: string, count: number, timeoutMs = 15_000): Promise<CallRecord[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = readCalls(dbPath, since);
    if (rows.length >= count || Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
