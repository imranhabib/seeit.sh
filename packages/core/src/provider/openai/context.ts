// Codex context parts (ADR 0009, context_parts; PLAN.md feature I): every
// input item, and each content part of a message, in input order, with a
// category, a safe label, and its tokens.
//
// Codex reports exact tokens per item and per content part in
// response.completed `usage.attribution.items` (PLAN.md, field inventory 1).
// Its keys are item IDs, sorted by ID, so parts are matched by ID, never by
// position. Items without an ID (the newest user message) are estimated.

import type { ContextCategory, ContextPart } from "../../records.ts";
import { estimateTokens, isObject, num, type Json } from "../model.ts";
import { contentChars } from "../tools.ts";

// Developer message parts start with a tag that names them (Codex 0.169.1).
const DEVELOPER_TAGS: Record<string, ContextCategory> = {
  skills_instructions: "skills",
  "permissions instructions": "permissions",
  collaboration_mode: "collaboration",
  tools: "deferred_tools",
  recommended_plugins: "plugins",
  multi_agent_role: "multi_agent",
  multi_agent_mode: "multi_agent",
};

type Counts = { input_tokens?: unknown; cached_tokens?: unknown; cache_write_tokens?: unknown; content?: unknown };

export function contextParts(body: Json, attribution: Json | null): ContextPart[] {
  const parts: ContextPart[] = [];
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (!isObject(item)) continue;
    const itemId = typeof item.id === "string" ? item.id : null;
    const role = typeof item.role === "string" ? item.role : null;
    const counts: Counts | null = itemId && isObject(attribution?.[itemId]) ? attribution[itemId] : null;
    if (item.type === "message" && Array.isArray(item.content)) {
      const perPart = Array.isArray(counts?.content) ? counts.content : null;
      item.content.forEach((content: unknown, i: number) => {
        const text = isObject(content) && typeof content.text === "string" ? content.text : "";
        // Item counts stand for the part only when the item has one part.
        const own = perPart ? perPart[i] : item.content.length === 1 ? counts : null;
        parts.push(part(parts.length, itemId, i, role, categorizeMessage(role, itemId, text), text.length || JSON.stringify(content).length, own));
      });
    } else {
      const chars = typeof item.type === "string" && item.type.endsWith("_output") ? contentChars(item.output) : JSON.stringify(item).length;
      parts.push(part(parts.length, itemId, null, role, categorizeItem(item), chars, counts));
    }
  }
  return parts;
}

function part(ordinal: number, itemId: string | null, index: number | null, role: string | null, c: { category: ContextCategory; label: string | null }, chars: number, counts: unknown): ContextPart {
  const exact = isObject(counts) && num(counts.input_tokens) !== null;
  return {
    ordinal,
    itemId,
    part: index,
    section: "input",
    role,
    ...c,
    chars,
    inputTokens: exact ? num(counts.input_tokens) : estimateTokens(chars),
    cachedTokens: exact ? num(counts.cached_tokens) : null,
    cacheWriteTokens: exact ? num(counts.cache_write_tokens) : null,
    tokensSource: exact ? "provider" : "estimated",
    breakpointTtl: null,
  };
}

function categorizeMessage(role: string | null, itemId: string | null, text: string): { category: ContextCategory; label: string | null } {
  const tag = text.match(/^\s*<([a-z_ ]+)>/)?.[1] ?? null;
  if (role === "developer") {
    if (tag && DEVELOPER_TAGS[tag]) return { category: DEVELOPER_TAGS[tag], label: tag };
    // The first developer message without a tag is the model's base instructions.
    return tag ? { category: "other", label: tag } : { category: "system_prompt", label: null };
  }
  if (role === "assistant") return { category: itemId?.startsWith("amsg") ? "subagent_message" : "assistant", label: null };
  if (role === "user") {
    if (tag === "environment_context") return { category: "environment", label: tag };
    if (text.startsWith("# AGENTS.md instructions") || tag === "user_instructions") return { category: "instructions_project", label: "instructions:project" };
    if (tag === "skill") return { category: "skills", label: tag };
    if (text.startsWith("Another language model started to solve this problem")) return { category: "compaction_summary", label: null };
    return { category: "user_prompt", label: null };
  }
  return { category: "other", label: null };
}

function categorizeItem(item: Json): { category: ContextCategory; label: string | null } {
  const type = typeof item.type === "string" ? item.type : "";
  if (type === "additional_tools") return { category: "tool_definitions", label: "additional_tools" };
  if (type === "reasoning") return { category: "reasoning", label: null };
  if (type.endsWith("_call_output")) return { category: "tool_result", label: null };
  if (type.endsWith("_call")) return { category: "tool_call", label: typeof item.name === "string" ? `tool:${item.name}` : null };
  return { category: "other", label: type || null };
}
