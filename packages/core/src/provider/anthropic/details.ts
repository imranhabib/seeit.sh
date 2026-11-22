// Claude Code facts for the ledger's detail columns and tool_uses table
// (ADR 0009). Read from the request, the response headers, and the parsed
// stream events.

import type { CallDetails, ToolResult, ToolUse } from "../../records.ts";
import { isObject, numberFrom, type Json } from "../model.ts";
import { classify, contentChars } from "../tools.ts";

type RequestPart = Pick<CallDetails, "harnessBuild" | "entrypoint" | "reasoningEffort" | "thinkingType" | "retryCount" | "features" | "compactionTrigger" | "cacheTtl">;
type ResponsePart = Pick<CallDetails, "providerRequestId" | "cacheMissReason" | "contextEdits" | "usageIterations" | "serviceTier" | "inferenceGeo">;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function requestDetails(headers: Headers, body: Json): RequestPart {
  // system[0] is a billing block: "x-anthropic-billing-header: cc_version=2.1.326.f48; cc_entrypoint=sdk-cli;"
  const billing = Array.isArray(body.system) ? str(body.system[0]?.text) : null;
  const beta = headers.get("anthropic-beta");
  return {
    harnessBuild: billing?.match(/cc_version=([^;\s]+)/)?.[1] ?? null,
    entrypoint: billing?.match(/cc_entrypoint=([^;\s]+)/)?.[1] ?? null,
    reasoningEffort: str(body.output_config?.effort),
    thinkingType: str(body.thinking?.type),
    retryCount: numberFrom(headers.get("x-stainless-retry-count")),
    features: beta ? beta.split(",").map((f) => f.trim()).filter(Boolean) : null,
    // Hint headers only (CLAUDE_CODE_GATEWAY_HINT_HEADERS=1): manual, auto, reactive.
    compactionTrigger: headers.get("x-claude-code-compaction"),
    cacheTtl: cacheTtl(body),
  };
}

// Claude Code marks every breakpoint of one call with the same lifetime: "1h"
// on the main agent, none (the 5-minute default) on subagents and compaction
// (PLAN.md, field inventory 4). The longest one is reported.
function cacheTtl(body: Json): string | null {
  const markers: Json[] = [];
  const collect = (block: unknown) => {
    if (isObject(block) && isObject(block.cache_control)) markers.push(block.cache_control);
  };
  for (const block of Array.isArray(body.system) ? body.system : []) collect(block);
  for (const tool of Array.isArray(body.tools) ? body.tools : []) collect(tool);
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    collect(message);
    for (const block of Array.isArray(message?.content) ? message.content : []) collect(block);
  }
  if (!markers.length) return null;
  return markers.some((m) => m.ttl === "1h") ? "1h" : "5m";
}

export function responseDetails(events: Json[], headers: Headers): ResponsePart {
  const details: ResponsePart = {
    providerRequestId: headers.get("request-id"),
    cacheMissReason: null,
    contextEdits: null,
    usageIterations: null,
    serviceTier: null,
    inferenceGeo: null,
  };
  for (const e of events) {
    if (e.type === "message_start") {
      const reason = e.message?.diagnostics?.cache_miss_reason;
      if (isObject(reason)) details.cacheMissReason = reason;
      details.serviceTier = str(e.message?.usage?.service_tier) ?? details.serviceTier;
      details.inferenceGeo = str(e.message?.usage?.inference_geo) ?? details.inferenceGeo;
    } else if (e.type === "message_delta") {
      const edits = e.context_management?.applied_edits;
      if (Array.isArray(edits)) details.contextEdits = edits;
      if (Array.isArray(e.usage?.iterations)) details.usageIterations = e.usage.iterations;
    }
  }
  return details;
}

/**
 * The tools the response asked for. Of the inputs, only Skill.skill and
 * Agent.subagent_type are read (ADR 0009: labels, never content).
 */
export function toolUses(events: Json[]): ToolUse[] {
  const blocks = new Map<number, { id: string; name: string; server: boolean; json: string }>();
  for (const e of events) {
    if (e.type === "content_block_start") {
      const b = e.content_block;
      const isTool = b?.type === "tool_use" || b?.type === "server_tool_use" || b?.type === "mcp_tool_use";
      if (isTool && typeof b.id === "string" && typeof b.name === "string") {
        blocks.set(e.index, { id: b.id, name: b.name, server: b.type !== "tool_use", json: "" });
      }
    } else if (e.type === "content_block_delta" && e.delta?.type === "input_json_delta") {
      const block = blocks.get(e.index);
      if (block && typeof e.delta.partial_json === "string") block.json += e.delta.partial_json;
    }
  }
  return [...blocks.values()].map(({ id, name, server, json }) => {
    if (server) return { toolUseId: id, kind: "server", name, namespace: null, target: null, plugin: null };
    return { toolUseId: id, namespace: null, ...classify(name, inputOf(json)) };
  });
}

function inputOf(json: string): Json {
  try {
    const v = JSON.parse(json);
    return isObject(v) ? v : {};
  } catch {
    return {}; // cut off mid-stream
  }
}

/** The size of each tool result in the request, for the tool use it answers. */
export function toolResults(body: Json): ToolResult[] {
  const results: ToolResult[] = [];
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        results.push({ toolUseId: block.tool_use_id, resultChars: contentChars(block.content) });
      }
    }
  }
  return results;
}
