// Anthropic Messages API: the types the gateway reads, and the event, block,
// delta, and usage names it knows. Anything else in a stream is drift
// (ADR 0005, layer 3): "known" means the interpreter either reads it or
// ignores it on purpose. Only add a name after deciding what to do with it.

import type {
  BetaMessageDeltaUsage,
  BetaRawMessageStreamEvent,
  BetaUsage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Loose } from "../model.ts";

/** The streaming docs' error event; the SDK types it outside the stream union. */
type AnthropicErrorEvent = { type: "error"; error: { type: string; message: string } };

/** One Anthropic stream event. `type` tells them apart. */
export type AnthropicEvent = Loose<BetaRawMessageStreamEvent | AnthropicErrorEvent | { type: "ping" }>;

/** Usage from message_start (BetaUsage) or message_delta (BetaMessageDeltaUsage), or both merged. */
export type AnthropicUsage = Loose<BetaUsage & BetaMessageDeltaUsage>;

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

/**
 * Content block types (content_block_start). Source: the content_block union
 * of BetaRawContentBlockStartEvent in @anthropic-ai/sdk 1.4.0.
 */
export const ANTHROPIC_BLOCKS = new Set([
  "text",
  "thinking",
  "redacted_thinking",
  "tool_use",
  "server_tool_use",
  "mcp_tool_use",
  "mcp_tool_result",
  "mcp_tool_listing",
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "tool_search_tool_result",
  "advisor_tool_result",
  "container_upload",
  "compaction",
  "fallback",
]);

/** Delta types (content_block_delta). Source: BetaRawContentBlockDelta in @anthropic-ai/sdk 1.4.0. */
export const ANTHROPIC_DELTAS = new Set([
  "text_delta",
  "thinking_delta",
  "input_json_delta",
  "compaction_delta",
  "signature_delta", // integrity data for a thinking block; not output
  "citations_delta", // source references attached to text; not output
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
