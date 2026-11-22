// The PostgreSQL ledger: one row per proxied call (ADR 0007), with the data
// model of ADR 0009 around it: users, sessions, turns, request pieces, tool
// uses, quota windows, context parts, and the Codex model catalog. Bodies
// live in separate tables so the calls table stays small and fast to query.
// The call columns are CallFields from @seeit/core (packages/core/src/call.ts);
// ingestion converts ISO times into Dates.

import {
  type AnyPgColumn,
  bigint,
  boolean,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// Drizzle 0.45 has no built-in bytea column; node-postgres reads/writes Buffer.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

/** seeit's own users (ADR 0009); "local" by default. Not provider accounts. No sign-in yet. */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  createdAt: time("created_at").notNull().defaultNow(),
});

/** One row per harness session. Totals are sums over calls, never stored here (ADR 0009). */
export const sessions = pgTable(
  "sessions",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    harness: text("harness").notNull(),
    id: text("id").notNull(), // from the harness
    harnessVersion: text("harness_version"),
    firstCallAt: time("first_call_at").notNull(),
    lastCallAt: time("last_call_at").notNull(),
    // ADR 0008 (turn assignment in the ledger) fills these; null until then.
    lastStartedAt: time("last_started_at"),
    lastSeq: bigint("last_seq", { mode: "number" }),
    settledAt: time("settled_at"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.harness, t.id] })],
);

/** One row per turn: the harness's turn ID, or the ID of the call that started an inferred turn. */
export const turns = pgTable(
  "turns",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    harness: text("harness").notNull(),
    sessionId: text("session_id"),
    startedByCallId: text("started_by_call_id").references((): AnyPgColumn => calls.id),
    startedAt: time("started_at").notNull(),
    source: text("source").notNull(), // "harness" | "inferred"
  },
  (t) => [foreignKey({ columns: [t.userId, t.harness, t.sessionId], foreignColumns: [sessions.userId, sessions.harness, sessions.id] })],
);

export const calls = pgTable(
  "calls",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    startedAt: time("started_at").notNull(),
    /** Request order within one gateway process (ADR 0008). Null for calls stored before it was sent. */
    seq: bigint("seq", { mode: "number" }),
    harness: text("harness").notNull(), // "claude" | "codex"
    harnessVersion: text("harness_version"),
    sessionId: text("session_id"),
    // Turn calls get their turn. Background calls with a session ID are linked
    // to the session's turn in progress (inferred; see apps/gateway/src/turns.ts).
    turnId: text("turn_id").references((): AnyPgColumn => turns.id),
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

    // Detail columns (ADR 0009, "Context parts, caching, and compaction
    // detail"); CallDetails in packages/core/src/records.ts. Null when the
    // harness does not send the field.
    /** Anthropic request-id (req_…) or OpenAI response ID (resp_…); joins to the harnesses' session files. */
    providerRequestId: text("provider_request_id"),
    compactionTrigger: text("compaction_trigger"), // "auto" | "manual" | "reactive"
    compactionReason: text("compaction_reason"), // Codex only, for example "context_limit"
    compactionPhase: text("compaction_phase"),
    compactionStrategy: text("compaction_strategy"),
    cacheTtl: text("cache_ttl"), // Claude: "5m" | "1h"
    cacheWrite30mTokens: bigint("cache_write_30m_tokens", { mode: "number" }),
    cacheWrite12hTokens: bigint("cache_write_12h_tokens", { mode: "number" }),
    promptCacheRetention: text("prompt_cache_retention"),
    contextEdits: jsonb("context_edits").$type<unknown[]>(),
    cacheMissReason: jsonb("cache_miss_reason").$type<Record<string, unknown>>(),
    usageIterations: jsonb("usage_iterations").$type<unknown[]>(),
    requestKind: text("request_kind"),
    contextWindowNumber: integer("context_window_number"),
    historyInitialization: text("history_initialization"),
    harnessTurnStartedAt: time("harness_turn_started_at"),
    harnessBuild: text("harness_build"),
    entrypoint: text("entrypoint"),
    retryCount: integer("retry_count"),
    reasoningEffort: text("reasoning_effort"),
    thinkingType: text("thinking_type"),
    serviceTier: text("service_tier"),
    inferenceGeo: text("inference_geo"),
    features: jsonb("features").$type<string[]>(),
  },
  (t) => [
    index("calls_started_at").on(t.startedAt),
    index("calls_session").on(t.sessionId, t.startedAt),
    index("calls_turn").on(t.turnId),
    foreignKey({ columns: [t.userId, t.harness, t.sessionId], foreignColumns: [sessions.userId, sessions.harness, sessions.id] }),
  ],
);

/**
 * The response of each call, gzipped. Requests are stored as pieces
 * (body_pieces, call_pieces). request_gz is no longer written; rows stored
 * before ADR 0009 keep their whole request there.
 */
export const bodies = pgTable("bodies", {
  callId: text("call_id")
    .primaryKey()
    .references(() => calls.id, { onDelete: "cascade" }),
  createdAt: time("created_at").notNull(),
  requestGz: bytea("request_gz"),
  responseGz: bytea("response_gz"),
});

/**
 * Each distinct request piece, stored once per user, harness, and scope
 * (ADR 0009). The scope is the session ID, or the call ID for a call with no
 * session, so pieces are never shared across sessions or users.
 */
export const bodyPieces = pgTable(
  "body_pieces",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    harness: text("harness").notNull(),
    scope: text("scope").notNull(),
    /** sha256 of the piece's JSON, without cache_control markers. */
    hash: text("hash").notNull(),
    gz: bytea("gz").notNull(),
    bytes: integer("bytes").notNull(), // before gzip
    firstSeenAt: time("first_seen_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.harness, t.scope, t.hash] })],
);

/** A request as its recipe: its pieces in order, with the cache markers that were taken out. */
export const callPieces = pgTable(
  "call_pieces",
  {
    callId: text("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    path: text("path").notNull(), // "tools", "system[1]", "messages[3]", "input[2]", "fields", "raw"
    hash: text("hash").notNull(), // body_pieces, with the call's user, harness, and scope
    cacheControl: jsonb("cache_control").$type<Record<string, unknown>>(),
  },
  (t) => [primaryKey({ columns: [t.callId, t.ordinal] })],
);

/** Tools the response asked for: labels only, never inputs or results (ADR 0009). */
export const toolUses = pgTable(
  "tool_uses",
  {
    callId: text("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    toolUseId: text("tool_use_id").notNull(),
    kind: text("kind").notNull(), // "builtin" | "mcp" | "skill" | "agent" | "server"
    name: text("name").notNull(),
    namespace: text("namespace"),
    target: text("target"), // skill name, subagent type, or MCP server
    plugin: text("plugin"),
    durationMs: doublePrecision("duration_ms"), // not read yet: Claude Code reports durations by tool name only
    /** Size of the result in a later request; filled when that request arrives. */
    resultChars: bigint("result_chars", { mode: "number" }),
  },
  (t) => [primaryKey({ columns: [t.callId, t.toolUseId] }), index("tool_uses_tool_use_id").on(t.toolUseId)],
);

/** One row per plan-quota window a response reported, in one shape for both harnesses (ADR 0009). */
export const quotaWindows = pgTable(
  "quota_windows",
  {
    callId: text("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    window: text("window").notNull(),
    harness: text("harness").notNull(),
    observedAt: time("observed_at").notNull(), // the call's started_at
    usedPercent: doublePrecision("used_percent"), // 0-100
    resetsAt: time("resets_at"),
    windowMinutes: integer("window_minutes"), // Codex only
    status: text("status"), // Claude Code only
  },
  (t) => [primaryKey({ columns: [t.callId, t.window] }), index("quota_windows_observed").on(t.harness, t.window, t.observedAt)],
);

/** Each part of the prompt, in prefix order, with its tokens and cache state (ADR 0009; PLAN.md feature I). */
export const contextParts = pgTable(
  "context_parts",
  {
    callId: text("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    itemId: text("item_id"), // Codex attribution key
    part: integer("part"),
    section: text("section").notNull(), // "tools" | "system" | "messages" | "input"
    role: text("role"),
    category: text("category").notNull(),
    label: text("label"), // a safe name, never a path or content
    chars: bigint("chars", { mode: "number" }).notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    cachedTokens: bigint("cached_tokens", { mode: "number" }),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }),
    tokensSource: text("tokens_source").notNull(), // "provider" | "breakpoint" | "estimated"
    breakpointTtl: text("breakpoint_ttl"),
    analysisVersion: integer("analysis_version").notNull(),
  },
  (t) => [primaryKey({ columns: [t.callId, t.ordinal] })],
);

/** Codex GET /models: one row per model, per user and harness version (the catalog can depend on the plan). */
export const modelCatalog = pgTable(
  "model_catalog",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    harness: text("harness").notNull(),
    harnessVersion: text("harness_version").notNull(), // the client_version query parameter when the user-agent names no version
    model: text("model").notNull(),
    callId: text("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    observedAt: time("observed_at").notNull(),
    contextWindow: bigint("context_window", { mode: "number" }),
    maxContextWindow: bigint("max_context_window", { mode: "number" }),
    autoCompactTokenLimit: bigint("auto_compact_token_limit", { mode: "number" }),
    compHash: text("comp_hash"),
    truncationMode: text("truncation_mode"),
    truncationLimit: bigint("truncation_limit", { mode: "number" }),
    toolMode: text("tool_mode"),
    baseInstructionsChars: bigint("base_instructions_chars", { mode: "number" }),
    baseInstructionsSha256: text("base_instructions_sha256"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.harness, t.harnessVersion, t.model] })],
);

export type CallRow = typeof calls.$inferInsert;
