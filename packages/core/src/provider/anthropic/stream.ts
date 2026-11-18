// Interprets an Anthropic Messages stream (Claude Code). Shared parts are in
// provider/stream.ts.

import { createStreamState, parse } from "../stream.ts";
import type { StreamInterpreter } from "../model.ts";
import { ANTHROPIC_BLOCKS, ANTHROPIC_DELTAS, ANTHROPIC_EVENTS, ANTHROPIC_USAGE_FIELDS, type AnthropicEvent, type AnthropicUsage } from "./model.ts";
import { fromAnthropicUsage } from "./usage.ts";

// Anthropic Messages: message_start → (content_block_start, content_block_delta*,
// content_block_stop)* → message_delta → message_stop
export function createAnthropicInterpreter(): StreamInterpreter {
  const { s, onOutput, onWholeOutput, noteEvent, noteUnknown, noteUsage, summary } = createStreamState(ANTHROPIC_EVENTS, ANTHROPIC_USAGE_FIELDS);
  // message_delta carries cumulative totals but may omit input fields, so
  // merge the raw objects and normalize the result.
  let raw: AnthropicUsage = {};
  return {
    onEvent(e, atMs) {
      const d = parse<AnthropicEvent>(e.data);
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
          const block = d.content_block;
          // The SDK types list every block type known today; a new one is drift.
          const blockType: string | null | undefined = block?.type;
          if (blockType && !ANTHROPIC_BLOCKS.has(blockType)) noteUnknown(`content_block_start:${blockType}`);
          if (block?.type === "redacted_thinking") {
            // Encrypted thinking: model output, but its data is not text the
            // model wrote, so it sets the first token but adds no characters.
            onWholeOutput(atMs);
          } else if (block?.type === "server_tool_use" || block?.type === "mcp_tool_use") {
            // Server-run tools (and MCP connector tools): their results become input.
            s.serverToolSeen = true;
          } else if (block?.type === "fallback") {
            // Server-side fallback: from here on, to.model writes the answer.
            s.fallback = true;
            s.model = block.to?.model ?? s.model;
          }
          // Server tool results (web_search_tool_result, ...) are not model
          // output: they become input, which message_delta's usage reports.
          break;
        }
        case "content_block_delta": {
          // Only these delta types carry text the model wrote. signature_delta
          // (and any delta type we do not know) is not output.
          const delta = d.delta;
          const deltaType: string | null | undefined = delta?.type;
          if (deltaType && !ANTHROPIC_DELTAS.has(deltaType)) noteUnknown(`content_block_delta:${deltaType}`);
          if (delta?.type === "text_delta") onOutput(delta.text, atMs);
          else if (delta?.type === "thinking_delta") onOutput(delta.thinking, atMs);
          else if (delta?.type === "input_json_delta") onOutput(delta.partial_json, atMs);
          // Server-side compaction: the summary the model wrote.
          else if (delta?.type === "compaction_delta") onOutput(delta.content, atMs);
          break;
        }
        case "message_delta":
          if (d.usage) {
            noteUsage(d.usage);
            s.usage = fromAnthropicUsage((raw = { ...raw, ...d.usage }));
            // Counts per server tool, for example {"web_search_requests": 1}.
            if (raw.server_tool_use) s.serverToolUse = raw.server_tool_use as Record<string, number>;
            // After a fallback, the serving model is the fallback_message entry
            // (refusals-and-fallback docs, "Streaming").
            const iterations = Array.isArray(d.usage.iterations) ? d.usage.iterations : [];
            for (const it of iterations) {
              if (it?.type === "fallback_message" && it.model) s.model = it.model; // the last one wins
            }
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
