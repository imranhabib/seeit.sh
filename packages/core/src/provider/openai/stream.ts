// Interprets an OpenAI Responses stream (Codex). Shared parts are in
// provider/stream.ts.

import { createStreamState, parse } from "../stream.ts";
import type { StreamInterpreter } from "../model.ts";
import { OPENAI_OUTPUT_DELTAS, OPENAI_RESPONSES_EVENTS, OPENAI_USAGE_FIELDS, type OpenAIEvent } from "./model.ts";
import { fromOpenAIUsage } from "./usage.ts";

// OpenAI Responses (Codex): response.created → … *.delta … → response.completed
export function createOpenAIInterpreter(): StreamInterpreter {
  const { s, onOutput, noteEvent, noteUsage, summary } = createStreamState(OPENAI_RESPONSES_EVENTS, OPENAI_USAGE_FIELDS);
  return {
    onEvent(e, atMs) {
      const d = parse<OpenAIEvent>(e.data);
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
