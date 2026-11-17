import { bigint, boolean, customType, doublePrecision, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Drizzle 0.45 has no built-in bytea column; node-postgres reads/writes Buffer.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

// Keep all fields from the current SQLite ledger. Ingestion will convert its
// ISO timestamps and serialized JSON into Date and structured JSON values.
export const calls = pgTable("calls", {
  id: text("id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true, precision: 3 }).notNull(),
  harness: text("harness").notNull(),
  harnessVersion: text("harness_version"),
  sessionId: text("session_id"),
  turnId: text("turn_id"),
  kind: text("kind").notNull(),
  method: text("method").notNull(),
  path: text("path").notNull(),
  httpStatus: integer("http_status"),
  completion: text("completion").notNull(),
  errorType: text("error_type"),
  model: text("model"),

  // Match SQLite's wider counters without narrowing them to PostgreSQL int4.
  // JavaScript-number values must remain within the safe integer range.
  inputTokens: bigint("input_tokens", { mode: "number" }),
  cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }),
  cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }),
  cacheWrite5mTokens: bigint("cache_write_5m_tokens", { mode: "number" }),
  cacheWrite1hTokens: bigint("cache_write_1h_tokens", { mode: "number" }),
  outputTokens: bigint("output_tokens", { mode: "number" }),
  reasoningTokens: bigint("reasoning_tokens", { mode: "number" }),
  codexRolloutBudgetUnits: doublePrecision("codex_rollout_budget_units"),
  serverToolUse: jsonb("server_tool_use").$type<Record<string, number>>(),
  tokensEstimated: boolean("tokens_estimated").notNull(),

  // PostgreSQL real is 32-bit; use double precision to preserve millisecond data.
  timeToResponseHeadersMs: doublePrecision("time_to_response_headers_ms"),
  timeToFirstChunkMs: doublePrecision("time_to_first_chunk_ms"),
  timeToFirstTokenMs: doublePrecision("time_to_first_token_ms"),
  timeToStreamEndMs: doublePrecision("time_to_stream_end_ms"),

  toolsCount: bigint("tools_count", { mode: "number" }),
  toolsChars: bigint("tools_chars", { mode: "number" }),
  instructionsChars: bigint("instructions_chars", { mode: "number" }),
  quota: jsonb("quota").$type<Record<string, string>>(),

  // SQL null means unchecked; an empty array/object means checked with no drift.
  flags: jsonb("flags").$type<string[]>(),
  unknownEvents: jsonb("unknown_events").$type<Record<string, number>>(),
  unknownUsageFields: jsonb("unknown_usage_fields").$type<string[]>(),
}, (t) => [index("calls_started_at").on(t.startedAt), index("calls_session").on(t.sessionId, t.startedAt)]);

export const bodies = pgTable("bodies", {
  callId: text("call_id").primaryKey().references(() => calls.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull(),
  requestGz: bytea("request_gz"),
  responseGz: bytea("response_gz"),
});

export type CallRow = typeof calls.$inferInsert;
