// Per-provider stream interpreters. The SSE parser turns bytes into events;
// an interpreter reads those events and keeps what the gateway needs:
// model, usage, whether the final event arrived, errors, and when the first
// model output arrived.

import type { SseEvent } from "./sse.ts";
import { estimateTokens, fromAnthropicUsage, fromOpenAIUsage, type Usage } from "./usage.ts";

export type Provider = "anthropic" | "openai-responses";

export type StreamSummary = {
  model: string | null;
  /** Usage as reported by the provider, or partly estimated if the stream was cut. */
  usage: Usage | null;
  /** The provider's final event arrived (message_stop / response.completed). */
  final: boolean;
  /** Error type from an error event in the stream, if any. */
  errorType: string | null;
  /** Time of the first model-output delta (the real time to first token). */
  timeToFirstTokenMs: number | null;
  /** Characters of model output received. Used to estimate output tokens. */
  outputChars: number;
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

function base() {
  const s: StreamSummary = {
    model: null,
    usage: null,
    final: false,
    errorType: null,
    timeToFirstTokenMs: null,
    outputChars: 0,
  };
  const onDelta = (text: unknown, atMs: number) => {
    s.timeToFirstTokenMs ??= atMs;
    if (typeof text === "string") s.outputChars += text.length;
  };
  // If the final event never came, the provider's output count is missing or
  // too low (Anthropic sends only a placeholder in message_start). Estimate it
  // from the output we did receive.
  const summary = (): StreamSummary => {
    if (s.final || !s.usage) return { ...s };
    return {
      ...s,
      usage: { ...s.usage, outputTokens: Math.max(s.usage.outputTokens, estimateTokens(s.outputChars)), estimated: true },
    };
  };
  return { s, onDelta, summary };
}

// Anthropic Messages: message_start → (content_block_start, content_block_delta*,
// content_block_stop)* → message_delta → message_stop
function anthropic(): StreamInterpreter {
  const { s, onDelta, summary } = base();
  // message_delta carries cumulative totals but may omit input fields, so
  // merge the raw objects and normalize the result.
  let raw: Json = {};
  return {
    onEvent(e, atMs) {
      const d = parse(e.data);
      if (!d) return;
      switch (d.type) {
        case "message_start":
          s.model = d.message?.model ?? null;
          if (d.message?.usage) s.usage = fromAnthropicUsage((raw = { ...d.message.usage }));
          break;
        case "content_block_delta": {
          const delta = d.delta ?? {};
          onDelta(delta.text ?? delta.thinking ?? delta.partial_json, atMs);
          break;
        }
        case "message_delta":
          if (d.usage) s.usage = fromAnthropicUsage((raw = { ...raw, ...d.usage }));
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

// OpenAI Responses (Codex): response.created → … *.delta … → response.completed
function openaiResponses(): StreamInterpreter {
  const { s, onDelta, summary } = base();
  return {
    onEvent(e, atMs) {
      const d = parse(e.data);
      if (!d) return;
      const type: string = d.type ?? e.event ?? "";
      if (type === "response.created") {
        s.model = d.response?.model ?? null;
      } else if (type.endsWith(".delta")) {
        // output_text, reasoning summary, and function-call argument deltas
        onDelta(d.delta, atMs);
      } else if (type === "response.completed" || type === "response.incomplete") {
        // "incomplete" = the model stopped early (for example a token limit),
        // but the stream itself finished normally and includes usage.
        s.final = true;
        s.model = d.response?.model ?? s.model;
        if (d.response?.usage) s.usage = fromOpenAIUsage(d.response.usage);
      } else if (type === "response.failed" || type === "error") {
        s.errorType = d.response?.error?.code ?? d.error?.code ?? d.code ?? type;
      }
    },
    summary,
  };
}
