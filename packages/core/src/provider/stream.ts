// Stream interpreting shared by every provider. The SSE parser turns bytes
// into events; a provider's interpreter (anthropic/stream.ts,
// openai/stream.ts) reads those events and keeps what the gateway needs:
// model, usage, whether the final event arrived, errors, and when the first
// model output arrived. It also keeps a few facts about the stream that the
// gateway's invariant checks use (apps/gateway/src/flags.ts).
//
// createStreamState holds what every interpreter does the same way: drift
// counting, output timing, and estimating output when a stream is cut.

import { estimateTokens, type StreamSummary } from "./model.ts";

/**
 * Parse an event's JSON data. The result is only an object, not checked
 * against T: the Loose types make the code treat every field as optional.
 */
export function parse<T>(data: string): T | null {
  try {
    const v: unknown = JSON.parse(data);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as T) : null;
  } catch {
    return null;
  }
}

export function createStreamState(knownEvents: Set<string>, knownUsageFields: Set<string>) {
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
  const noteUnknown = (key: string) => {
    s.unknownEvents[key] = (s.unknownEvents[key] ?? 0) + 1;
  };
  const noteEvent = (type: string) => {
    if (!knownEvents.has(type)) noteUnknown(type);
  };
  const noteUsage = (usage: object) => {
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
  return { s, onOutput, onWholeOutput, noteEvent, noteUnknown, noteUsage, summary };
}
