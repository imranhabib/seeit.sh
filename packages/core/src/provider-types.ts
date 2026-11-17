// Types for the provider fields the interpreters read (PLAN.md follow-up step 3).
//
// They come from the official SDKs, installed as dev dependencies for their
// types only: the gateway never uses an SDK to send a request (AGENTS.md).
// Both versions are pinned in packages/core/package.json.
//
// The types only help the compiler. Nothing checks them at runtime, so the
// data can still be missing or have the wrong type; usage.ts checks every
// number with num().

import type {
  BetaMessageDeltaUsage,
  BetaRawMessageStreamEvent,
  BetaUsage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Response, ResponseErrorEvent, ResponseUsage } from "openai/resources/responses/responses";

/**
 * A fail-soft view of a provider type: every field, at every depth, may be
 * missing or null. Harnesses and providers drop fields between versions, so
 * the compiler should make us handle that everywhere (with ?. and ??).
 */
export type Loose<T> =
  // Plain values stay as they are. This check comes first because the SDKs
  // type model names as `"claude-..." | (string & {})`, and `string & {}`
  // would otherwise be treated as an object.
  T extends string | number | boolean ? T : T extends object ? { [K in keyof T]?: Loose<T[K]> | null } : T;

// --- Anthropic Messages ------------------------------------------------------

/** The streaming docs' error event; the SDK types it outside the stream union. */
type AnthropicErrorEvent = { type: "error"; error: { type: string; message: string } };

/** One Anthropic stream event. `type` tells them apart. */
export type AnthropicEvent = Loose<BetaRawMessageStreamEvent | AnthropicErrorEvent | { type: "ping" }>;

/** Usage from message_start (BetaUsage) or message_delta (BetaMessageDeltaUsage), or both merged. */
export type AnthropicUsage = Loose<BetaUsage & BetaMessageDeltaUsage>;

// --- OpenAI Responses, as Codex reads it --------------------------------------

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
