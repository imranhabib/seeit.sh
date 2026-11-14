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
    turnId: text("turn_id"), // null for background calls
    kind: text("kind").notNull(), // "turn" | "background"
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
    outputTokens: integer("output_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
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
