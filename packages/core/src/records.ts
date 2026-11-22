// The facts analyzeCall reads for the ledger tables besides `calls`
// (ADR 0009): request pieces, tool uses, quota windows, context parts, and
// the Codex model catalog. Provider code fills them; the ledger stores them.
//
// Labels only, never content: tool and skill names, categories, sizes, and
// token counts. Inputs read for labels are listed in ADR 0009 ("tool_uses
// stores labels, never content").

/** New `calls` columns (ADR 0009, "Context parts, caching, and compaction detail"). Null when the harness does not send the field. */
export type CallDetails = {
  /** Anthropic `request-id` header (req_…) or the OpenAI response ID (resp_…). Joins to the harnesses' session files. */
  providerRequestId: string | null;
  compactionTrigger: string | null;
  compactionReason: string | null;
  compactionPhase: string | null;
  compactionStrategy: string | null;
  /** Claude: the lifetime the cache breakpoints ask for, "5m" or "1h". */
  cacheTtl: string | null;
  cacheWrite30mTokens: number | null;
  cacheWrite12hTokens: number | null;
  promptCacheRetention: string | null;
  /** Claude `context_management.applied_edits`; [] = checked, nothing removed. */
  contextEdits: unknown[] | null;
  /** Claude `message.diagnostics.cache_miss_reason`, for example {type, cache_missed_input_tokens}. */
  cacheMissReason: Record<string, unknown> | null;
  /** Claude `usage.iterations`, the usage of each attempt. */
  usageIterations: unknown[] | null;
  requestKind: string | null;
  contextWindowNumber: number | null;
  historyInitialization: string | null;
  /** Codex `turn_started_at_unix_ms`, as ISO 8601. */
  harnessTurnStartedAt: string | null;
  harnessBuild: string | null;
  entrypoint: string | null;
  retryCount: number | null;
  reasoningEffort: string | null;
  thinkingType: string | null;
  serviceTier: string | null;
  inferenceGeo: string | null;
  /** Claude `anthropic-beta` list; Codex `x-codex-beta-features`. */
  features: string[] | null;
};

export const NO_DETAILS: CallDetails = {
  providerRequestId: null,
  compactionTrigger: null,
  compactionReason: null,
  compactionPhase: null,
  compactionStrategy: null,
  cacheTtl: null,
  cacheWrite30mTokens: null,
  cacheWrite12hTokens: null,
  promptCacheRetention: null,
  contextEdits: null,
  cacheMissReason: null,
  usageIterations: null,
  requestKind: null,
  contextWindowNumber: null,
  historyInitialization: null,
  harnessTurnStartedAt: null,
  harnessBuild: null,
  entrypoint: null,
  retryCount: null,
  reasoningEffort: null,
  thinkingType: null,
  serviceTier: null,
  inferenceGeo: null,
  features: null,
};

/** One part of a request, stored once per session (ADR 0009, body_pieces). */
export type RequestPiece = {
  /** "tools", "system[1]", "messages[3]", "input[2]", "fields", or "raw" for a body that is not a JSON object. */
  path: string;
  /** The piece without cache_control markers: what is hashed and stored. */
  value: unknown;
  /** The markers that were removed, by place inside the piece ("" = the piece itself, "content[1]"); null if none. */
  cacheControl: Record<string, unknown> | null;
};

export type ToolUseKind = "builtin" | "mcp" | "skill" | "agent" | "server";

/** A tool the model asked for in its response (ADR 0009, tool_uses). */
export type ToolUse = {
  toolUseId: string;
  kind: ToolUseKind;
  name: string;
  namespace: string | null;
  /** Skill name, subagent type, or MCP server. */
  target: string | null;
  plugin: string | null;
};

/** A tool result sent back in a request: its size, for the tool use it answers. */
export type ToolResult = { toolUseId: string; resultChars: number };

/** One plan-quota window from the response headers (ADR 0009, quota_windows). */
export type QuotaWindow = {
  window: string;
  /** 0-100. */
  usedPercent: number | null;
  /** ISO 8601. */
  resetsAt: string | null;
  windowMinutes: number | null;
  status: string | null;
};

export type ContextCategory =
  | "system_prompt"
  | "tool_definitions"
  | "deferred_tools"
  | "instructions_global"
  | "instructions_project"
  | "environment"
  | "skills"
  | "plugins"
  | "mcp"
  | "permissions"
  | "collaboration"
  | "multi_agent"
  | "hook_output"
  | "compaction_summary"
  | "user_prompt"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "reasoning"
  | "subagent_message"
  | "other";

/** One part of the prompt, in prefix order (ADR 0009, context_parts; PLAN.md feature I). */
export type ContextPart = {
  ordinal: number;
  /** Codex input item ID (the attribution key); null for Claude. */
  itemId: string | null;
  /** Content part index inside the item or message; null for the whole item. */
  part: number | null;
  section: "tools" | "system" | "messages" | "input";
  role: string | null;
  category: ContextCategory;
  /** A safe name such as "tool:Bash"; never a path or content. */
  label: string | null;
  chars: number;
  inputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  tokensSource: "provider" | "breakpoint" | "estimated";
  /** Claude: "5m" or "1h" when a cache breakpoint ends this part. */
  breakpointTtl: string | null;
};

/** Raises when the rules that make context parts change, so old rows can be told apart. */
export const CONTEXT_ANALYSIS_VERSION = 1;

/** One model from Codex `GET /models` (ADR 0009, model_catalog). */
export type ModelCatalogEntry = {
  model: string;
  contextWindow: number | null;
  maxContextWindow: number | null;
  autoCompactTokenLimit: number | null;
  compHash: string | null;
  truncationMode: string | null;
  truncationLimit: number | null;
  toolMode: string | null;
  baseInstructionsChars: number | null;
  baseInstructionsSha256: string | null;
};

/** Everything analyzeCall reads for the tables besides `calls`. */
export type CallRecords = {
  pieces: RequestPiece[];
  toolUses: ToolUse[];
  toolResults: ToolResult[];
  quotaWindows: QuotaWindow[];
  contextParts: ContextPart[];
  modelCatalog: ModelCatalogEntry[];
};
