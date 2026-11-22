// Claude Code context parts (ADR 0009, context_parts; PLAN.md feature I):
// every part of the prompt in the order the cache sees it, tools → system →
// messages, with a category, a safe label, and its token count.
//
// Anthropic reports totals only, so each part's tokens are estimated from
// its characters. The cache breakpoints still say which parts were read,
// written, or uncached: a cache read ends at a breakpoint, the write runs
// from there to the last breakpoint, and everything after the last
// breakpoint is uncached input. A stretch between those points with only one
// part has an exact count (the provider's total for that stretch). The
// difference between the estimates and the totals is never spread over the
// parts.

import type { ContextCategory, ContextPart } from "../../records.ts";
import { isObject, type Json, type Usage } from "../model.ts";
import { contentChars } from "../tools.ts";

/**
 * Characters per token for Claude Code prompts: 14,345 tokens for about
 * 40,000 characters on a first call (PLAN.md, field inventory 2). One ratio
 * for now; a ratio per kind of content comes when Iris checks them.
 */
export const CLAUDE_CHARS_PER_TOKEN = 2.8;

type Draft = Omit<ContextPart, "inputTokens" | "cachedTokens" | "cacheWriteTokens" | "tokensSource" | "ordinal">;

export function contextParts(body: Json, usage: Usage | null): ContextPart[] {
  const drafts: Draft[] = [];
  const add = (d: Omit<Draft, "itemId" | "breakpointTtl">, block: unknown) => drafts.push({ ...d, itemId: null, breakpointTtl: ttlOf(block) });

  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    const name = typeof tool?.name === "string" ? tool.name : null;
    const category: ContextCategory = name?.startsWith("mcp__") ? "mcp" : tool?.defer_loading === true ? "deferred_tools" : "tool_definitions";
    add({ section: "tools", role: null, part: null, category, label: name ? `tool:${name}` : null, chars: JSON.stringify(withoutMarker(tool)).length }, tool);
  }
  (Array.isArray(body.system) ? body.system : []).forEach((block: unknown) => {
    const text = isObject(block) && typeof block.text === "string" ? block.text : "";
    const billing = text.startsWith("x-anthropic-billing-header:");
    add({ section: "system", role: "system", part: null, category: "system_prompt", label: billing ? "billing" : null, chars: blockChars(block) }, block);
  });
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const role = typeof message?.role === "string" ? message.role : null;
    const blocks: unknown[] = Array.isArray(message?.content) ? message.content : [message?.content ?? ""];
    blocks.forEach((block, i) => {
      const { category, label } = categorize(role, block);
      // A marker on the message itself counts for its last block.
      const marked = i === blocks.length - 1 && ttlOf(message) && !ttlOf(block) ? message : block;
      add({ section: "messages", role, part: i, category, label, chars: blockChars(block) }, marked);
    });
  }
  return withTokens(drafts, usage);
}

function categorize(role: string | null, block: unknown): { category: ContextCategory; label: string | null } {
  // Claude Code 2.1.326 puts environment notes and newly available tools in role "system" messages.
  if (role === "system") return { category: "environment", label: null };
  const type = isObject(block) ? block.type : "text";
  const text = typeof block === "string" ? block : isObject(block) && typeof block.text === "string" ? block.text : "";
  if (role === "assistant") {
    if (type === "tool_use" || type === "server_tool_use") return { category: "tool_call", label: isObject(block) && typeof block.name === "string" ? `tool:${block.name}` : null };
    if (type === "thinking" || type === "redacted_thinking") return { category: "reasoning", label: null };
    return { category: type === "text" ? "assistant" : "other", label: null };
  }
  if (type === "tool_result") return { category: "tool_result", label: null };
  if (type !== "text") return { category: "other", label: null };
  if (text.startsWith("This session is being continued from a previous conversation")) return { category: "compaction_summary", label: null };
  if (!text.trimStart().startsWith("<system-reminder>")) return { category: "user_prompt", label: null };
  // Reminders the harness adds. Only the headers are read for the label: the
  // kind of instruction file, never its path.
  const global = text.includes("(user's private global instructions");
  const project = text.includes("(project instructions");
  if (global || project) {
    const kinds = [global && "global", project && "project"].filter(Boolean).join(",");
    return { category: project ? "instructions_project" : "instructions_global", label: `instructions:${kinds}` };
  }
  if (text.includes("skills are available")) return { category: "skills", label: null };
  if (/\bhook\b/i.test(text)) return { category: "hook_output", label: null };
  return { category: "other", label: "system-reminder" };
}

function withTokens(drafts: Draft[], usage: Usage | null): ContextPart[] {
  const estimates = drafts.map((d) => Math.ceil(d.chars / CLAUDE_CHARS_PER_TOKEN));
  const parts: ContextPart[] = drafts.map((d, i) => ({
    ...d,
    ordinal: i,
    inputTokens: estimates[i]!,
    cachedTokens: null,
    cacheWriteTokens: null,
    tokensSource: "estimated",
  }));
  const read = usage?.cacheReadTokens;
  const write = usage?.cacheWriteTokens;
  const uncached = usage?.inputTokens;
  if (!usage || usage.estimated || read == null || write == null || uncached == null) return parts;

  const breakpoints = parts.filter((p) => p.breakpointTtl).map((p) => p.ordinal);
  const last = breakpoints.at(-1) ?? -1;
  // Where the read ends: nothing read; or, with nothing written, the last
  // breakpoint; otherwise the earlier breakpoint whose estimated prefix is
  // closest to the tokens read.
  let readEnd = -1;
  if (read > 0) {
    readEnd = last;
    if (write > 0) {
      const prefix = (end: number) => estimates.slice(0, end + 1).reduce((a, b) => a + b, 0);
      const earlier = breakpoints.slice(0, -1);
      readEnd = earlier.reduce((best, b) => (Math.abs(prefix(b) - read) < Math.abs(prefix(best) - read) ? b : best), earlier[0] ?? -1);
    }
  }
  const segments: [number, number, number, "read" | "write" | "uncached"][] = [
    [0, readEnd, read, "read"],
    [readEnd + 1, last, write, "write"],
    [last + 1, parts.length - 1, uncached, "uncached"],
  ];
  for (const [from, to, total, state] of segments) {
    const members = parts.slice(from, to + 1);
    if (members.length === 1) Object.assign(members[0]!, { inputTokens: total, tokensSource: "breakpoint" });
    for (const p of members) {
      p.cachedTokens = state === "read" ? p.inputTokens : 0;
      p.cacheWriteTokens = state === "write" ? p.inputTokens : 0;
    }
  }
  return parts;
}

function ttlOf(block: unknown): string | null {
  if (!isObject(block) || !isObject(block.cache_control)) return null;
  return block.cache_control.ttl === "1h" ? "1h" : "5m";
}

function withoutMarker(block: unknown): unknown {
  if (!isObject(block)) return block;
  const { cache_control: _marker, ...rest } = block;
  return rest;
}

function blockChars(block: unknown): number {
  if (typeof block === "string") return block.length;
  if (!isObject(block)) return 0;
  if (typeof block.text === "string") return block.text.length;
  if (typeof block.thinking === "string") return block.thinking.length;
  if (block.type === "tool_result") return contentChars(block.content);
  return JSON.stringify(withoutMarker(block)).length;
}
