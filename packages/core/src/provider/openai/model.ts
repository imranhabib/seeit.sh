// OpenAI Responses API, as the Codex backend sends it: the types the gateway
// reads, and the event, delta, and usage names it knows. Anything else in a
// stream is drift (ADR 0005, layer 3): "known" means the interpreter either
// reads it or ignores it on purpose. Only add a name after deciding what to do with it.

import type { Response, ResponseErrorEvent, ResponseUsage } from "openai/resources/responses/responses";
import type { Loose } from "../model.ts";

/**
 * OpenAI's ResponseUsage plus the fields only Codex's backend sends.
 * Source: ResponseCompletedUsage in codex-rs/codex-api/src/sse/responses.rs at
 * https://github.com/openai/codex/blob/9537934ed6d5a6658fc77032b3290650765466a1/codex-rs/codex-api/src/sse/responses.rs
 */
type CodexUsage = ResponseUsage & {
  codex_rollout_budget_units: number;
  /** Per-item token split; present in some Codex versions only. */
  attribution: unknown;
};

/**
 * One Codex stream event, with the fields Codex itself reads: its
 * ResponsesStreamEvent struct (same file as above) has a string `type` and
 * keeps `response` and `error` as untyped JSON. The parts of those we read
 * are typed with the OpenAI SDK.
 */
export type OpenAIEvent = Loose<{
  type: string;
  /** Text for model-output deltas (Rust: Option<String>). Other events may send an object. */
  delta: unknown;
  /** Error code on OpenAI's top-level error event. */
  code: ResponseErrorEvent["code"];
  error: { code: string | null };
  response: Pick<Response, "model" | "error"> & { usage: CodexUsage };
}>;

export type OpenAIUsage = Loose<CodexUsage>;

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

// Delta events that carry text the model wrote. Not every "*.delta" does:
// response.shell_call_output_content.delta is a command's stdout (tool
// output), and response.audio.delta is base64 audio. Source: the delta event
// types in the OpenAI Node SDK, src/resources/responses/responses.ts at
// openai/openai-node@4517ca801b79a93ccc17826b0b63ba2313355307.
export const OPENAI_OUTPUT_DELTAS = new Set([
  "response.output_text.delta",
  "response.refusal.delta",
  "response.reasoning_text.delta",
  "response.reasoning_summary_text.delta",
  "response.function_call_arguments.delta",
  "response.custom_tool_call_input.delta",
  "response.mcp_call_arguments.delta",
  "response.code_interpreter_call_code.delta",
  "response.shell_call_command.delta",
]);
