// Codex facts for the ledger's detail columns, tool_uses, and model_catalog
// tables (ADR 0009). Read from the request, its turn metadata, the parsed
// stream events, and the GET /models response.

import { createHash } from "node:crypto";
import type { CallDetails, ModelCatalogEntry, ToolResult, ToolUse } from "../../records.ts";
import { classify, contentChars } from "../tools.ts";
import { isObject, isoFromUnix, num, parseJson, type Json } from "../model.ts";

type RequestPart = Pick<
  CallDetails,
  | "requestKind"
  | "contextWindowNumber"
  | "historyInitialization"
  | "harnessTurnStartedAt"
  | "compactionTrigger"
  | "compactionReason"
  | "compactionPhase"
  | "compactionStrategy"
  | "reasoningEffort"
  | "features"
>;
type ResponsePart = Pick<CallDetails, "providerRequestId" | "promptCacheRetention" | "serviceTier" | "cacheWrite30mTokens" | "cacheWrite12hTokens">;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The x-codex-turn-metadata header, or the same JSON in client_metadata. */
export function turnMetadata(headers: Headers, body: Json): Json {
  return parseJson(headers.get("x-codex-turn-metadata")) ?? parseJson(body.client_metadata?.["x-codex-turn-metadata"]) ?? {};
}

export function requestDetails(headers: Headers, body: Json, meta: Json): RequestPart {
  const beta = headers.get("x-codex-beta-features");
  return {
    requestKind: str(meta.request_kind),
    contextWindowNumber: num(meta.window_number),
    historyInitialization: str(meta.history_initialization),
    harnessTurnStartedAt: isoFromUnix(num(meta.turn_started_at_unix_ms), "ms"),
    compactionTrigger: str(meta.compaction?.trigger),
    compactionReason: str(meta.compaction?.reason),
    compactionPhase: str(meta.compaction?.phase),
    compactionStrategy: str(meta.compaction?.strategy),
    reasoningEffort: str(body.reasoning?.effort) ?? str(meta.reasoning_effort),
    features: beta ? beta.split(/[\s,]+/).filter(Boolean) : null,
  };
}

export function responseDetails(events: Json[]): ResponsePart {
  const details: ResponsePart = { providerRequestId: null, promptCacheRetention: null, serviceTier: null, cacheWrite30mTokens: null, cacheWrite12hTokens: null };
  for (const e of events) {
    const r = e.response;
    if (!isObject(r)) continue;
    details.providerRequestId = str(r.id) ?? details.providerRequestId;
    if (e.type !== "response.completed" && e.type !== "response.incomplete") continue;
    details.promptCacheRetention = str(r.prompt_cache_retention);
    details.serviceTier = str(r.service_tier);
    const split = r.usage?.input_tokens_details?.cache_write_tokens_details;
    details.cacheWrite30mTokens = num(split?.ttl_30m_tokens);
    details.cacheWrite12hTokens = num(split?.ttl_12h_tokens);
  }
  return details;
}

/**
 * The tools the response asked for. Since 0.169 (code mode) the model calls
 * most tools from JavaScript it writes for the `exec` tool, so the exec call
 * gets a row, and each `tools.<name>(` in its code gets one more, with the ID
 * "<call_id>#<n>" (ADR 0009). Only tool names are read from the code.
 */
export function toolUses(events: Json[]): ToolUse[] {
  const uses: ToolUse[] = [];
  for (const e of events) {
    if (e.type !== "response.output_item.done" || !isObject(e.item)) continue;
    const item = e.item;
    const id = str(item.call_id) ?? str(item.id);
    if (!id) continue;
    if (item.type === "web_search_call") {
      uses.push({ toolUseId: id, kind: "server", name: "web_search", namespace: null, target: null, plugin: null });
    } else if ((item.type === "custom_tool_call" || item.type === "function_call") && typeof item.name === "string") {
      const namespace = str(item.namespace);
      // spawn_agent in the collaboration namespace starts a subagent; its
      // arguments are content and are not read.
      const kind = namespace === "collaboration" && item.name === "spawn_agent" ? { kind: "agent" as const, name: item.name, target: null, plugin: null } : classify(item.name);
      uses.push({ toolUseId: id, namespace, ...kind });
      if (item.name === "exec" && typeof item.input === "string") {
        const calls = [...item.input.matchAll(/\btools\.([A-Za-z_$][\w$]*)\s*\(/g)];
        calls.forEach((m, i) => uses.push({ toolUseId: `${id}#${i + 1}`, namespace: null, ...classify(m[1]!) }));
      }
    }
  }
  return uses;
}

/** The size of each tool output in the request, for the call it answers. */
export function toolResults(body: Json): ToolResult[] {
  const results: ToolResult[] = [];
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (typeof item?.type === "string" && item.type.endsWith("_call_output") && typeof item.call_id === "string") {
      results.push({ toolUseId: item.call_id, resultChars: contentChars(item.output) });
    }
  }
  return results;
}

/** Codex GET /models: one row per model with its compaction and truncation settings. */
export function modelCatalog(text: string | null): ModelCatalogEntry[] {
  const models = parseJson(text)?.models;
  if (!Array.isArray(models)) return [];
  return models
    .filter((m): m is Json => isObject(m) && typeof m.slug === "string")
    .map((m) => {
      const base = str(m.base_instructions);
      return {
        model: m.slug,
        contextWindow: num(m.context_window),
        maxContextWindow: num(m.max_context_window),
        autoCompactTokenLimit: num(m.auto_compact_token_limit),
        compHash: str(m.comp_hash),
        truncationMode: str(m.truncation_policy?.mode),
        truncationLimit: num(m.truncation_policy?.limit),
        toolMode: str(m.tool_mode),
        baseInstructionsChars: base === null ? null : base.length,
        // A changed base prompt changes the hash; the text itself is not stored.
        baseInstructionsSha256: base === null ? null : createHash("sha256").update(base).digest("hex"),
      };
    });
}
