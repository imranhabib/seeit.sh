// The PostgreSQL ledger: one row per proxied call (ADR 0007). Bodies live in a
// separate table so the calls table stays small and fast to query. The
// columns are CallFields from @seeit/core (packages/core/src/call.ts);
// ingestion converts the ISO start time into a Date.

import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// Drizzle 0.45 has no built-in bytea column; node-postgres reads/writes Buffer.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const calls = pgTable(
  "calls",
  {
    id: text("id").primaryKey(),
    startedAt: timestamp("started_at", { withTimezone: true, precision: 3 }).notNull(),
    harness: text("harness").notNull(), // "claude" | "codex"
    harnessVersion: text("harness_version"),
    sessionId: text("session_id"),
    // Turn calls get their turn. Background calls with a session ID are linked
    // to the session's turn in progress (inferred; see apps/gateway/src/turns.ts).
    turnId: text("turn_id"),
    /** Subagent ID (Claude Code: x-claude-code-agent-id; Codex: the spawned agent's thread_id); null for the main agent. Subagent calls share the user's turn. */
    agentId: text("agent_id"),
    kind: text("kind").notNull(), // "turn" | "background" | "connectivity" (CallKind in packages/core/src/provider/model.ts)
    method: text("method").notNull(),
    path: text("path").notNull(),
    httpStatus: integer("http_status"), // null if upstream never answered
    completion: text("completion").notNull(), // see packages/core/src/completion.ts
    errorType: text("error_type"),
    model: text("model"),

    // Tokens. inputTokens is UNCACHED input; total input = input + cache read + cache write.
    // bigint, not PostgreSQL int4, so large counters are never narrowed.
    // JavaScript-number values must remain within the safe integer range.
    inputTokens: bigint("input_tokens", { mode: "number" }),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }),
    // cache_write_tokens split by cache lifetime; billed at different rates. Null when the provider sends no split.
    cacheWrite5mTokens: bigint("cache_write_5m_tokens", { mode: "number" }),
    cacheWrite1hTokens: bigint("cache_write_1h_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    reasoningTokens: bigint("reasoning_tokens", { mode: "number" }),
    codexRolloutBudgetUnits: doublePrecision("codex_rollout_budget_units"), // Codex only; meaning undocumented
    /** Anthropic usage.server_tool_use, for example {"web_search_requests":1}. Billed per use. Null when not reported. */
    serverToolUse: jsonb("server_tool_use").$type<Record<string, number>>(),
    tokensEstimated: boolean("tokens_estimated").notNull(),

    // Timings in ms since the gateway received the request (PLAN.md, "Timings per call").
    // PostgreSQL real is 32-bit; use double precision to preserve millisecond data.
    timeToResponseHeadersMs: doublePrecision("time_to_response_headers_ms"),
    timeToFirstChunkMs: doublePrecision("time_to_first_chunk_ms"),
    timeToFirstTokenMs: doublePrecision("time_to_first_token_ms"),
    timeToStreamEndMs: doublePrecision("time_to_stream_end_ms"),

    // Size of the fixed prompt parts (feature A builds on these).
    toolsCount: bigint("tools_count", { mode: "number" }),
    toolsChars: bigint("tools_chars", { mode: "number" }),
    instructionsChars: bigint("instructions_chars", { mode: "number" }),

    /** Plan-quota response headers, or null when the response had none. */
    quota: jsonb("quota").$type<Record<string, string>>(),

    // Drift detection (ADR 0005, layer 3). SQL null means unchecked; an empty
    // array/object means checked with no drift.
    /** Broken invariants, for example ["complete_without_usage"]. */
    flags: jsonb("flags").$type<string[]>(),
    /** Event types not in the known lists (packages/core/src/provider/<provider>/model.ts), with counts: {"type": n}. */
    unknownEvents: jsonb("unknown_events").$type<Record<string, number>>(),
    /** Top-level usage fields not in the known lists (packages/core/src/provider/<provider>/model.ts): ["field"]. */
    unknownUsageFields: jsonb("unknown_usage_fields").$type<string[]>(),
  },
  (t) => [index("calls_started_at").on(t.startedAt), index("calls_session").on(t.sessionId, t.startedAt)],
);

export const bodies = pgTable("bodies", {
  callId: text("call_id")
    .primaryKey()
    .references(() => calls.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull(),
  requestGz: bytea("request_gz"),
  responseGz: bytea("response_gz"),
});

export type CallRow = typeof calls.$inferInsert;
