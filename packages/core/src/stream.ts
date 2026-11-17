// Per-provider stream interpreters. The SSE parser turns bytes into events;
// an interpreter reads those events and keeps what the gateway needs:
// model, usage, whether the final event arrived, errors, and when the first
// model output arrived. It also keeps a few facts about the stream that the
// gateway's invariant checks use (apps/gateway/src/flags.ts).

import { ANTHROPIC_EVENTS, ANTHROPIC_USAGE_FIELDS, OPENAI_RESPONSES_EVENTS, OPENAI_USAGE_FIELDS } from "./known.ts";
import type { SseEvent } from "./sse.ts";
import { estimateTokens, fromAnthropicUsage, fromOpenAIUsage, type Usage } from "./usage.ts";

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
  /** Event types not in known.ts, with how often each arrived. Drift signal. */
  unknownEvents: Record<string, number>;
  /** Top-level usage fields not in known.ts. Drift signal. */
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

export function createInterpreter(provider: Provider): StreamInterpreter {
  return provider === "anthropic" ? anthropic() : openaiResponses();
}

type Json = Record<string, any>;

function parse(data: string): Json | null {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function base(knownEvents: Set<string>, knownUsageFields: Set<string>) {
  const s: StreamSummary = {
    model: null,
    startModel: null,
    usage: null,
    final: false,
    errorType: null,
    timeToFirstTokenMs: null,
    outputChars: 0,
    unknownEvents: {},
    unknownUsageFields: [],
    startInputTokens: null,
    fallback: false,
    serverToolUse: null,
    serverToolSeen: false,
  };
  // Drift: remember what we do not know, but keep parsing (fail-soft).
  const noteEvent = (type: string) => {
    if (!knownEvents.has(type)) s.unknownEvents[type] = (s.unknownEvents[type] ?? 0) + 1;
  };
  const noteUsage = (usage: Json) => {
    for (const field of Object.keys(usage)) {
      if (!knownUsageFields.has(field) && !s.unknownUsageFields.includes(field)) s.unknownUsageFields.push(field);
    }
  };
  // Model-written text arrived. An empty string is not output yet: every tool
  // call starts with an empty input_json_delta, and thinking with display
  // "omitted" sends one empty thinking_delta (PLAN.md, streaming gap 4).
  const onOutput = (text: unknown, atMs: number) => {
    if (typeof text !== "string" || text === "") return;
    s.timeToFirstTokenMs ??= atMs;
    s.outputChars += text.length;
  };
  // Output that arrives as one whole block with no countable text.
  const onWholeOutput = (atMs: number) => {
    s.timeToFirstTokenMs ??= atMs;
  };
  // If the final event never came, the provider's output count is missing or
  // too low (Anthropic sends only a placeholder in message_start). Estimate it
  // from the output we did receive.
  const summary = (): StreamSummary => {
    if (s.final || !s.usage) return { ...s };
    return {
      ...s,
      usage: { ...s.usage, outputTokens: Math.max(s.usage.outputTokens ?? 0, estimateTokens(s.outputChars)), estimated: true },
    };
  };
  return { s, onOutput, onWholeOutput, noteEvent, noteUsage, summary };
}

// Anthropic Messages: message_start → (content_block_start, content_block_delta*,
// content_block_stop)* → message_delta → message_stop
function anthropic(): StreamInterpreter {
  const { s, onOutput, onWholeOutput, noteEvent, noteUsage, summary } = base(ANTHROPIC_EVENTS, ANTHROPIC_USAGE_FIELDS);
  // message_delta carries cumulative totals but may omit input fields, so
  // merge the raw objects and normalize the result.
  let raw: Json = {};
  return {
    onEvent(e, atMs) {
      const d = parse(e.data);
      if (!d) return;
      noteEvent(d.type ?? e.event ?? "(no type)");
      switch (d.type) {
        case "message_start":
          s.model = s.startModel = d.message?.model ?? null;
          if (d.message?.usage) {
            noteUsage(d.message.usage);
            s.usage = fromAnthropicUsage((raw = { ...d.message.usage }));
            s.startInputTokens = s.usage.inputTokens;
          }
          break;
        // Some blocks arrive whole, with no deltas (streaming docs, "Event types").
        case "content_block_start": {
          const block = d.content_block ?? {};
          if (block.type === "redacted_thinking") {
            // Encrypted thinking: model output, but its data is not text the
            // model wrote, so it sets the first token but adds no characters.
            onWholeOutput(atMs);
          } else if (block.type === "server_tool_use") {
            s.serverToolSeen = true;
          } else if (block.type === "fallback") {
            // Server-side fallback: from here on, to.model writes the answer.
            s.fallback = true;
            s.model = block.to?.model ?? s.model;
          }
          // Server tool results (web_search_tool_result, ...) are not model
          // output: they become input, which message_delta's usage reports.
          break;
        }
        case "content_block_delta": {
          const delta = d.delta ?? {};
          // signature_delta has none of these fields, so it is ignored.
          onOutput(delta.text ?? delta.thinking ?? delta.partial_json, atMs);
          break;
        }
        case "message_delta":
          if (d.usage) {
            noteUsage(d.usage);
            s.usage = fromAnthropicUsage((raw = { ...raw, ...d.usage }));
            if (isObject(raw.server_tool_use)) s.serverToolUse = raw.server_tool_use;
            // After a fallback, the serving model is the fallback_message entry
            // (refusals-and-fallback docs, "Streaming").
            const iterations: Json[] = Array.isArray(d.usage.iterations) ? d.usage.iterations : [];
            const served = iterations.findLast((it) => it?.type === "fallback_message")?.model;
            if (typeof served === "string") s.model = served;
          }
          break;
        case "message_stop":
          s.final = true;
          break;
        case "error":
          s.errorType = d.error?.type ?? "error";
          break;
      }
    },
    summary,
  };
}

// Delta events that carry text the model wrote. Not every "*.delta" does:
// response.shell_call_output_content.delta is a command's stdout (tool
// output), and response.audio.delta is base64 audio. Source: the delta event
// types in the OpenAI Node SDK, src/resources/responses/responses.ts at
// openai/openai-node@4517ca801b79a93ccc17826b0b63ba2313355307.
const OPENAI_OUTPUT_DELTAS = new Set([
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

// OpenAI Responses (Codex): response.created → … *.delta … → response.completed
function openaiResponses(): StreamInterpreter {
  const { s, onOutput, noteEvent, noteUsage, summary } = base(OPENAI_RESPONSES_EVENTS, OPENAI_USAGE_FIELDS);
  return {
    onEvent(e, atMs) {
      const d = parse(e.data);
      if (!d) return;
      const type: string = d.type ?? e.event ?? "";
      noteEvent(type || "(no type)");
      if (type === "response.created") {
        s.model = s.startModel = d.response?.model ?? null;
      } else if (OPENAI_OUTPUT_DELTAS.has(type)) {
        onOutput(d.delta, atMs);
      } else if (type === "response.completed" || type === "response.incomplete") {
        // "incomplete" = the model stopped early (for example a token limit),
        // but the stream itself finished normally and includes usage.
        s.final = true;
        s.model = d.response?.model ?? s.model;
        if (d.response?.usage) {
          noteUsage(d.response.usage);
          s.usage = fromOpenAIUsage(d.response.usage);
        }
      } else if (type === "response.failed" || type === "error") {
        s.errorType = d.response?.error?.code ?? d.error?.code ?? d.code ?? type;
      }
    },
    summary,
  };
}
