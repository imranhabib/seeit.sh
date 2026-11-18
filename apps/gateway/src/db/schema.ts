// The ledger: one row per proxied call (ADR 0003). Bodies live in a separate
// table so the calls table stays small and fast to query.

import { blob, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const calls = sqliteTable(
  "calls",
  {
    id: text("id").primaryKey(),
    startedAt: text("started_at").notNull(), // ISO 8601, UTC
    harness: text("harness").notNull(), // "claude" | "codex"
    harnessVersion: text("harness_version"),
    sessionId: text("session_id"),
    // Turn calls get their turn. Background calls with a session ID are linked
    // to the session's turn in progress (inferred; see apps/gateway/src/turns.ts),
    // so per-turn token totals include a tool's own model calls.
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
    inputTokens: integer("input_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    // cache_write_tokens split by cache lifetime; billed at different rates. Null when the provider sends no split.
    cacheWrite5mTokens: integer("cache_write_5m_tokens"),
    cacheWrite1hTokens: integer("cache_write_1h_tokens"),
    outputTokens: integer("output_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    codexRolloutBudgetUnits: real("codex_rollout_budget_units"), // Codex only; meaning undocumented
    /** Anthropic usage.server_tool_use as JSON, for example {"web_search_requests":1}. Billed per use. Null when not reported. */
    serverToolUse: text("server_tool_use"),
    tokensEstimated: integer("tokens_estimated", { mode: "boolean" }).notNull(),

    // Timings in ms since the gateway received the request (PLAN.md, "Timings per call").
    timeToResponseHeadersMs: real("time_to_response_headers_ms"),
    timeToFirstChunkMs: real("time_to_first_chunk_ms"),
    timeToFirstTokenMs: real("time_to_first_token_ms"),
    timeToStreamEndMs: real("time_to_stream_end_ms"),

    // Size of the fixed prompt parts (feature A builds on these).
    toolsCount: integer("tools_count"),
    toolsChars: integer("tools_chars"),
    instructionsChars: integer("instructions_chars"),

    /** Plan-quota response headers as JSON, or null when the response had none. */
    quota: text("quota"),

    // Drift detection (ADR 0005, layer 3). All JSON. Null on rows recorded
    // before these checks existed; "[]" / "{}" means checked, nothing found.
    /** Broken invariants, for example ["complete_without_usage"]. See src/flags.ts. */
    flags: text("flags"),
    /** Event types not in the known lists (packages/core/src/provider/<provider>/model.ts), with counts: {"type": n}. */
    unknownEvents: text("unknown_events"),
    /** Top-level usage fields not in the known lists (packages/core/src/provider/<provider>/model.ts): ["field"]. */
    unknownUsageFields: text("unknown_usage_fields"),
  },
  (t) => [index("calls_started_at").on(t.startedAt), index("calls_session").on(t.sessionId, t.startedAt)],
);

export const bodies = sqliteTable("bodies", {
  callId: text("call_id")
    .primaryKey()
    .references(() => calls.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
  requestGz: blob("request_gz", { mode: "buffer" }),
  responseGz: blob("response_gz", { mode: "buffer" }),
});

export type CallRow = typeof calls.$inferInsert;
