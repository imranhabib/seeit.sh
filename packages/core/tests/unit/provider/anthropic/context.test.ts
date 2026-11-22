import { describe, expect, it } from "vitest";
import { contextParts } from "../../../../src/provider/anthropic/context.ts";
import type { Usage } from "../../../../src/provider/model.ts";

const bp = (ttl?: string) => ({ type: "ephemeral", ...(ttl ? { ttl } : {}) });
const usage = (read: number, write: number, input: number): Usage => ({
  inputTokens: input,
  cacheReadTokens: read,
  cacheWriteTokens: write,
  cacheWrite5mTokens: null,
  cacheWrite1hTokens: null,
  outputTokens: 1,
  reasoningTokens: null,
  codexRolloutBudgetUnits: null,
  estimated: false,
});

// The layout of a Claude Code 2.1.326 request (PLAN.md, field inventory 2-3).
const body = {
  tools: [{ name: "Read" }, { name: "Bash", defer_loading: true }, { name: "mcp__iris__echo" }],
  system: [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.326.f48; cc_entrypoint=sdk-cli;" },
    { type: "text", text: "You are Claude Code.", cache_control: bp("1h") },
    { type: "text", text: "Main prompt ".repeat(100), cache_control: bp("1h") },
  ],
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "<system-reminder>\nContents of /x/CLAUDE.md (user's private global instructions for all projects):\n...\nContents of /p/CLAUDE.md (project instructions, checked into the codebase):\n</system-reminder>" },
        { type: "text", text: "<system-reminder>\nThe following skills are available for use with the Skill tool:\n</system-reminder>" },
        { type: "text", text: "Explain src/math.js" },
      ],
    },
    { role: "system", content: "Environment notes" },
    { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Reading." }, { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/p/src/math.js" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "file text", cache_control: bp("1h") }] },
    { role: "system", content: "New tools available" },
  ],
};

describe("contextParts: claude", () => {
  it("lists every part in prefix order (tools, system, messages) with a category and a safe label", () => {
    const parts = contextParts(body, null);
    expect(parts.map((p) => [p.ordinal, p.section, p.role, p.part, p.category, p.label])).toEqual([
      [0, "tools", null, null, "tool_definitions", "tool:Read"],
      [1, "tools", null, null, "deferred_tools", "tool:Bash"],
      [2, "tools", null, null, "mcp", "tool:mcp__iris__echo"],
      [3, "system", "system", null, "system_prompt", "billing"],
      [4, "system", "system", null, "system_prompt", null],
      [5, "system", "system", null, "system_prompt", null],
      [6, "messages", "user", 0, "instructions_project", "instructions:global,project"],
      [7, "messages", "user", 1, "skills", null],
      [8, "messages", "user", 2, "user_prompt", null],
      [9, "messages", "system", 0, "environment", null],
      [10, "messages", "assistant", 0, "reasoning", null],
      [11, "messages", "assistant", 1, "assistant", null],
      [12, "messages", "assistant", 2, "tool_call", "tool:Read"],
      [13, "messages", "user", 0, "tool_result", null],
      [14, "messages", "system", 0, "environment", null],
    ]);
    expect(parts.every((p) => p.itemId === null && p.chars > 0)).toBe(true);
    expect(parts.filter((p) => p.breakpointTtl).map((p) => [p.ordinal, p.breakpointTtl])).toEqual([[4, "1h"], [5, "1h"], [13, "1h"]]);
  });

  it("without usage, gives estimates only and leaves the cache state unknown", () => {
    const parts = contextParts(body, null);
    expect(parts.every((p) => p.tokensSource === "estimated" && p.inputTokens! > 0 && p.cachedTokens === null && p.cacheWriteTokens === null)).toBe(true);
  });

  // The read ends at a breakpoint, the write runs to the last breakpoint, and
  // everything after it is uncached (PLAN.md, field inventory 2-3).
  it("splits the parts into read, written, and uncached at the breakpoints", () => {
    const est = contextParts(body, null).map((p) => p.inputTokens!);
    const upToSystem = est.slice(0, 6).reduce((a, b) => a + b, 0);
    const parts = contextParts(body, usage(upToSystem + 3, 900, 40));
    const state = parts.map((p) => (p.cachedTokens! > 0 ? "read" : p.cacheWriteTokens! > 0 ? "write" : "uncached"));
    expect(state).toEqual([...Array(6).fill("read"), ...Array(8).fill("write"), "uncached"]);
    // Only a segment with one part has an exact count; the others stay estimates.
    expect(parts[14]).toMatchObject({ inputTokens: 40, cachedTokens: 0, cacheWriteTokens: 0, tokensSource: "breakpoint" });
    expect(parts[0]).toMatchObject({ tokensSource: "estimated", inputTokens: est[0], cachedTokens: est[0], cacheWriteTokens: 0 });
  });

  it("reads everything up to the last breakpoint when nothing was written", () => {
    const parts = contextParts(body, usage(5000, 0, 40));
    expect(parts.slice(0, 14).every((p) => p.cachedTokens === p.inputTokens && p.cacheWriteTokens === 0)).toBe(true);
  });

  it("treats a call without breakpoints as all uncached", () => {
    const parts = contextParts({ messages: [{ role: "user", content: "search results" }], tools: [{ type: "web_search_20250305", name: "web_search" }] }, usage(0, 0, 11000));
    expect(parts.map((p) => [p.cachedTokens, p.cacheWriteTokens])).toEqual([[0, 0], [0, 0]]);
  });

  it("labels a compaction summary and hook output", () => {
    const parts = contextParts(
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "This session is being continued from a previous conversation that ran out of context." }] },
          { role: "user", content: [{ type: "text", text: "<system-reminder>\nUserPromptSubmit hook success: ok\n</system-reminder>" }] },
        ],
      },
      null,
    );
    expect(parts.map((p) => p.category)).toEqual(["compaction_summary", "hook_output"]);
  });
});
