// Types and helpers shared by every provider (Anthropic, OpenAI) and harness
// (Claude Code, Codex). Provider-specific code lives in provider/anthropic/
// and provider/openai/; this file must not import from them.

import type { SseEvent } from "../sse.ts";

// --- Fail-soft provider types --------------------------------------------------

/**
 * A fail-soft view of a provider type: every field, at every depth, may be
 * missing or null. Harnesses and providers drop fields between versions, so
 * the compiler should make us handle that everywhere (with ?. and ??).
 *
 * The provider types come from the official SDKs, installed as dev
 * dependencies for their types only: the gateway never uses an SDK to send a
 * request (AGENTS.md). The types only help the compiler. Nothing checks them
 * at runtime, so the data can still be missing or have the wrong type; usage
 * code checks every number with num().
 */
export type Loose<T> =
  // Plain values stay as they are. This check comes first because the SDKs
  // type model names as `"claude-..." | (string & {})`, and `string & {}`
  // would otherwise be treated as an object.
  T extends string | number | boolean ? T : T extends object ? { [K in keyof T]?: Loose<T[K]> | null } : T;

/** Untyped JSON object, for request bodies the gateway reads field by field. */
export type Json = Record<string, any>;

export function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse a JSON string that must hold an object; null otherwise. */
export function parseJson(text: unknown): Json | null {
  if (typeof text !== "string") return null;
  try {
    const v = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

/** The value if it is a number, otherwise null (missing, null, or a wrong type). */
export function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

// --- Requests ------------------------------------------------------------------

export type Harness = "claude" | "codex";
/**
 * turn: part of a prompt the user typed. background: a side request (quota
 * probe, title, model list). connectivity: a HEAD request that only checks the
 * gateway and upstream can be reached; it uses no tokens.
 */
export type CallKind = "turn" | "background" | "connectivity";

export type RequestInfo = {
  /**
   * "claude-cli/2.1.322", "codex_exec/0.169.0", "Codex Desktop/0.169.0-alpha.11.1".
   * Null when the user-agent is not the harness's own (for example "Bun/1.4.4").
   */
  harnessVersion: string | null;
  sessionId: string | null;
  /** Turn ID sent by the harness (Codex). Claude sends none; see startsNewTurn. */
  explicitTurnId: string | null;
  /**
   * Subagent ID; null for the main agent. Claude Code: x-claude-code-agent-id.
   * Codex: the spawned agent's thread_id from the turn metadata.
   */
  agentId: string | null;
  kind: CallKind;
  /** Claude only: true when this call starts a new user turn (inferred). */
  startsNewTurn: boolean;
  /**
   * Claude only, set when startsNewTurn: identifies the user message that
   * starts the turn, as "<position>:<hash of block 1>,<hash of block 2>,...".
   * After a failed call the harness sends that message again; compare keys
   * with resendsTurnStart so the turn tracker keeps such a call in its turn.
   */
  turnKey: string | null;
  model: string | null;
  context: ContextShape;
};

/** Size of the fixed parts of the prompt. Phase 2 builds feature A on this. */
export type ContextShape = {
  toolsCount: number;
  toolsChars: number;
  instructionsChars: number;
};

// --- Usage ---------------------------------------------------------------------
//
// One usage shape for every provider. Providers count input differently:
// - Anthropic: `input_tokens` EXCLUDES cache reads and cache writes.
// - OpenAI:    `input_tokens` INCLUDES cached tokens (they are a subset).
// We store the Anthropic meaning: `inputTokens` is uncached input only, so
// total input = inputTokens + cacheReadTokens + cacheWriteTokens for both.
//
// A field the provider did not send is null (unknown), never 0. A 0 would
// claim "no tokens" when we simply do not know.

export type Usage = {
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /**
   * The cache write split by lifetime: billed at different rates (PLAN.md,
   * live-run finding 6). Anthropic only; null when the split is missing.
   * Together they equal cacheWriteTokens.
   */
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
  outputTokens: number | null;
  /** Thinking / reasoning tokens. Already included in outputTokens. */
  reasoningTokens: number | null;
  /**
   * Codex only: `codex_rollout_budget_units` from response.completed usage, a
   * decimal number. Its meaning is not documented; stored so it can be studied.
   * Null when missing (always for Anthropic).
   */
  codexRolloutBudgetUnits: number | null;
  /** True when some numbers are gateway estimates, not provider-reported. */
  estimated: boolean;
};

/** Rough rule of thumb for English text and code. Only used for estimates. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// --- Streams -------------------------------------------------------------------

export type Provider = "anthropic" | "openai-responses";

export type StreamSummary = {
  /** The model that served the response (after a fallback: the fallback model). */
  model: string | null;
  /** The model named when the stream started (message_start / response.created). */
  startModel: string | null;
  /** Usage as reported by the provider, or partly estimated if the stream was cut. */
  usage: Usage | null;
  /** The provider's final event arrived (message_stop / response.completed). */
  final: boolean;
  /** Error type from an error event in the stream, if any. */
  errorType: string | null;
  /**
   * The real time to first token: the first delta with model-written content
   * (text, thinking text, tool input), or the start of an output block that
   * arrives whole (redacted_thinking). Empty deltas and signatures do not count.
   */
  timeToFirstTokenMs: number | null;
  /** Characters of model output received. Used to estimate output tokens. */
  outputChars: number;
  /**
   * Event types not in the provider's known lists (<provider>/model.ts), with how often each arrived. Drift signal.
   * Unknown Anthropic block and delta types are counted here too, as
   * "content_block_start:<type>" and "content_block_delta:<type>".
   */
  unknownEvents: Record<string, number>;
  /** Top-level usage fields not in the provider's known lists. Drift signal. */
  unknownUsageFields: string[];
  /** Anthropic: uncached input tokens in message_start, before server tools add any. */
  startInputTokens: number | null;
  /** Anthropic server-side fallback: a different model took over during the call. */
  fallback: boolean;
  /** Anthropic `usage.server_tool_use` counts (for example {"web_search_requests": 1}), billed per use. */
  serverToolUse: Record<string, number> | null;
  /** A server tool block (server_tool_use) appeared, so input may grow during the stream. */
  serverToolSeen: boolean;
};

export type StreamInterpreter = {
  onEvent(event: SseEvent, atMs: number): void;
  summary(): StreamSummary;
};

// --- Header values -------------------------------------------------------------

/** A header value as a number, or null when it is missing or not a number. */
export function numberFrom(text: string | null | undefined): number | null {
  if (text === null || text === undefined || text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** Unix time (seconds or milliseconds) as ISO 8601, or null. */
export function isoFromUnix(value: number | null, unit: "s" | "ms" = "s"): string | null {
  if (value === null) return null;
  const date = new Date(unit === "s" ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
