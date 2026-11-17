// Event types and usage fields the gateway knows about, per provider.
//
// "Known" means the interpreter either reads it or ignores it on purpose.
// Anything else is drift: the provider or harness started sending something
// new. The interpreters count drift on every call (ADR 0005, layer 3), so a
// format change shows up in the ledger instead of going unnoticed.
//
// Only add a name here after deciding what the gateway should do with it.

/** Source: https://platform.claude.com/docs/en/build-with-claude/streaming */
export const ANTHROPIC_EVENTS = new Set([
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
  "ping",
  "error",
]);

/** Top-level fields of Anthropic `usage`. Seen in the claude-cli 2.1.322 fixture, plus server_tool_use from the docs. */
export const ANTHROPIC_USAGE_FIELDS = new Set([
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "cache_creation", // split by cache lifetime (5-minute / 1-hour)
  "output_tokens_details",
  "server_tool_use",
  "service_tier",
  "inference_geo",
  "speed",
  "iterations",
  "fallback_credit", // refusal credit token (BetaUsage in @anthropic-ai/sdk); not a token count, ignored
]);

/**
 * Every event type Codex's own stream parser handles: codex-rs/codex-api/src/sse/responses.rs
 * at openai/codex@9537934ed6d5a6658fc77032b3290650765466a1 (the match in process_responses_event),
 * plus codex.rate_limits from codex-rs/codex-api/src/rate_limits.rs.
 */
export const OPENAI_RESPONSES_EVENTS = new Set([
  "error",
  "response.created",
  "response.in_progress",
  "response.metadata",
  "codex.response.metadata",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.custom_tool_call_input.delta",
  "response.custom_tool_call_input.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_text.delta",
  "response.completed",
  "response.incomplete",
  "response.failed",
  "responsesapi.websocket_timing",
  "codex.rate_limits",
]);

/** Top-level fields of OpenAI Responses `usage` (ResponseCompletedUsage in the same Codex file, plus attribution from our fixtures). */
export const OPENAI_USAGE_FIELDS = new Set([
  "input_tokens",
  "input_tokens_details",
  "output_tokens",
  "output_tokens_details",
  "total_tokens",
  "codex_rollout_budget_units",
  "attribution", // per-item token split; present in some Codex versions only
]);
