// The scenarios Iris records (PLAN.md, Phase 1 follow-ups step 4).
//
// Each one is a short, fresh session in a reset sandbox. Steps after the
// first continue the same session.
//
// Model output differs between runs (other words, another number of tool
// calls), so expectations describe structure: how many turns, how calls
// ended, and what the response streams must contain to prove the scenario
// exercised its feature. check.ts adds rules that hold for every scenario.

import type { Harness } from "@seeit/core";

export type Step = {
  prompt: string;
  /** Continue the previous step's session (claude --continue / codex exec resume --last). */
  continue?: boolean;
  /** Codex app-server driver only: compact the thread instead of sending the prompt. */
  compact?: boolean;
};

export type Expect = {
  /** Distinct turn IDs among the turn calls. Leave out while a rule is still undecided. */
  turns?: number;
  /** Calls that did not complete, by status. Default: every call completes. */
  incomplete?: Partial<Record<"upstream_dropped" | "client_aborted" | "upstream_error", number>>;
  /** Chaos-proxy markers that must appear in at least one call (see Observed.markers). */
  saw?: string[];
  /**
   * Requests that are known to fail in this scenario, as "METHOD /path"
   * (without query). Their upstream errors are not counted as problems.
   */
  knownFailures?: string[];
  /**
   * At least this many different subagents made calls (calls with an agent
   * ID), and every one of their calls is in the parent's turn.
   */
  subagents?: number;
};

export type Scenario = {
  id: string;
  harness: Harness;
  /** What this scenario is meant to show. */
  about: string;
  steps: Step[];
  expect: Expect;
  /** Add the UserPromptSubmit hook to the sandbox (both harnesses). */
  hook?: boolean;
  /** Add the iris-note skill to the sandbox (both harnesses). */
  skill?: boolean;
  /** Give the harness the Iris MCP server (fixtures/mcp-server.mjs). */
  mcp?: boolean;
  /** Load the Iris plugin: --plugin-dir for Claude Code; installed into Iris's CODEX_HOME for Codex. */
  plugin?: boolean;
  /**
   * Codex only: run the steps through `codex app-server` instead of
   * `codex exec`, for steps exec cannot do (a manual compaction).
   */
  driver?: "app-server";
  /**
   * During the first step, after this many answer-text deltas of a turn:
   * "cut" drops the provider connection; "interrupt" sends Ctrl+C to the harness.
   */
  fault?: { action: "cut" | "interrupt"; afterTextDeltas: number };
  /** Claude Code tools allowed without asking (headless mode cannot ask). */
  allowedTools?: string[];
  /**
   * Claude Code: effort level (--effort). With adaptive thinking, a
   * lightweight model at the default effort may not think at all.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Keep slash commands (needed for /compact, skills, and plugins); off by default to skip account-synced skills. */
  slashCommands?: boolean;
  /** Extra environment for the harness process. */
  env?: Record<string, string>;
  /** Codex: extra -c config overrides. */
  codexConfig?: string[];
  /**
   * Codex: keep the built-in OpenAI provider and only point its base URL at
   * the gateway, instead of the custom "seeit" provider from the README.
   * Codex offers hosted tools (web_search) only on its built-in provider.
   */
  codexBuiltinProvider?: boolean;
};

const READ_ONLY = ["Read", "Glob", "Grep"];
const EDIT_AND_TEST = [...READ_ONLY, "Write", "Edit", "Bash(node:*)", "Bash(ls:*)"];
const TOOL_LOOP = "Add a unit test file for every function in src/, using node:test, then run the tests with node --test and fix any failures.";
const LONG_ANSWER = "Write a long, detailed explanation of how JavaScript modules work, with examples. Do not use any tools.";
const FIND_BREAKS = "Think carefully: which functions in src/ would break on unusual input, and why?";
// Hard enough that the model has to reason before answering.
const PUZZLE =
  "Without using any tools: in src/dates.js, isWeekend uses getDay(). For every day from 2026-12-28 to 2027-01-03, work out whether isWeekend returns true when the Date is created with new Date('YYYY-MM-DD') and the process runs in UTC-5. Explain each step.";

export const SCENARIOS: Scenario[] = [
  {
    id: "claude-tool-loop",
    harness: "claude",
    about: "Many calls in one turn: tool_use / tool_result loop",
    allowedTools: EDIT_AND_TEST,
    steps: [{ prompt: TOOL_LOOP }],
    // hint:*: the gateway hint headers name the prompt and request class (ADR 0008).
    expect: { turns: 1, saw: ["block:tool_use", "hint:prompt-id", "hint:request-class:main"] },
  },
  {
    id: "codex-tool-loop",
    harness: "codex",
    about: "Many calls in one turn: tool calls and outputs",
    steps: [{ prompt: TOOL_LOOP }],
    expect: { turns: 1, saw: ["item:custom_tool_call"] },
  },
  {
    id: "claude-subagent",
    harness: "claude",
    about: "Subagent calls stay in the turn that started them (x-claude-code-agent-id)",
    allowedTools: [...READ_ONLY, "Task", "Agent"],
    steps: [{ prompt: "Use a subagent to find every TODO comment in this repository, then summarize what it found." }],
    expect: { turns: 1, subagents: 1, saw: ["hint:request-class:subagent"] },
  },
  {
    id: "claude-parallel-subagents",
    harness: "claude",
    about: "Two subagents at the same time: their calls interleave but stay in one turn",
    allowedTools: [...READ_ONLY, "Task", "Agent"],
    steps: [{ prompt: "Start two subagents at the same time, in one message: one explains src/math.js, the other explains src/strings.js. Then combine their answers." }],
    expect: { turns: 1, subagents: 2 },
  },
  {
    id: "codex-subagent",
    harness: "codex",
    about: "spawn_agent: the spawned agent's calls stay in the user's turn (root_turn_id)",
    steps: [{ prompt: "Use spawn_agent to start one agent that finds every TODO comment in this repository. Wait for it, then summarize what it found." }],
    expect: { turns: 1, subagents: 1 },
  },
  {
    id: "codex-parallel-subagents",
    harness: "codex",
    about: "Two spawned agents at the same time: their calls interleave but stay in one turn",
    steps: [{ prompt: "Use spawn_agent to start two agents at the same time: one explains src/math.js, the other explains src/strings.js. Wait for both, then combine their answers." }],
    expect: { turns: 1, subagents: 2 },
  },
  {
    id: "claude-compaction",
    harness: "claude",
    about: "/compact, and a new prompt after it. The compact call itself counts as a turn.",
    allowedTools: READ_ONLY,
    slashCommands: true,
    steps: [
      { prompt: "Explain src/math.js in two sentences." },
      { prompt: "Now explain src/strings.js in two sentences.", continue: true },
      { prompt: "Which of the two files has more TODO comments?", continue: true },
      { prompt: "/compact", continue: true },
      { prompt: "What did we talk about so far?", continue: true },
    ],
    // The /compact call still counts as a turn: the parser does not read the
    // compaction header yet (ADR 0009 makes it background). No
    // x-claude-code-context-compacted: each -p step is a new process, and
    // the next process did not send it (seen 2026-11-18).
    expect: { turns: 5, saw: ["hint:compaction:manual", "hint:request-class:compaction"] },
  },
  {
    id: "codex-compaction",
    harness: "codex",
    about: "Automatic compaction (request_kind \"compaction\"): a background call linked to its turn; turns stay per prompt",
    // Just above the starting prompt size seen with gpt-6-luna on Codex
    // 0.169.1 (about 11,600 tokens); the long answers push the session past it.
    codexConfig: ["model_auto_compact_token_limit=13000"],
    steps: [
      { prompt: "Without using any tools, write a 500-word explanation of how JavaScript modules work." },
      { prompt: "Now write a 500-word explanation of how npm resolves package versions.", continue: true },
      { prompt: "Now write a 500-word explanation of the Node.js event loop.", continue: true },
      { prompt: "What did we talk about so far? Answer in two sentences.", continue: true },
    ],
    expect: { turns: 4, saw: ["request-kind:compaction", "compaction-trigger:auto"] },
  },
  {
    id: "codex-manual-compaction",
    harness: "codex",
    about: "Manual compaction (/compact; thread/compact/start through codex app-server): a background call, trigger manual",
    driver: "app-server",
    steps: [
      { prompt: "Without using any tools, explain in two sentences what a JavaScript module is." },
      { prompt: "/compact", compact: true },
      { prompt: "What did we talk about so far? Answer in one sentence." },
    ],
    expect: { turns: 2, saw: ["request-kind:compaction", "compaction-trigger:manual"] },
  },
  {
    id: "codex-hook",
    harness: "codex",
    about: "A UserPromptSubmit hook adds context to the prompt without changing turn detection",
    hook: true,
    steps: [{ prompt: "Which indentation does this project use? Answer in one sentence." }],
    expect: { turns: 1, saw: ["request:hook-note"] },
  },
  {
    id: "claude-hook",
    harness: "claude",
    about: "A UserPromptSubmit hook adds context to the prompt without changing turn detection",
    hook: true,
    allowedTools: READ_ONLY,
    steps: [{ prompt: "Which indentation does this project use? Answer in one sentence." }],
    expect: { turns: 1, saw: ["request:hook-note"] },
  },
  {
    id: "claude-mcp",
    harness: "claude",
    about: "An MCP tool (mcp__iris__echo) from the Iris MCP server",
    mcp: true,
    allowedTools: ["mcp__iris__echo"],
    steps: [{ prompt: "Call the echo tool from the iris MCP server with the text hello, then tell me what it returned." }],
    expect: { turns: 1, saw: ["tool:mcp__iris__echo", "request:mcp-echo"] },
  },
  {
    id: "codex-mcp",
    harness: "codex",
    about: "An MCP tool from the Iris MCP server, called from JavaScript in the exec tool (code mode)",
    mcp: true,
    steps: [{ prompt: "Call the echo tool from the iris MCP server with the text hello, then tell me what it returned." }],
    expect: { turns: 1, saw: ["exec-tool:mcp__iris__echo", "request:mcp-echo"] },
  },
  {
    id: "claude-skill",
    harness: "claude",
    about: "A repository skill (.claude/skills), loaded with the Skill tool",
    skill: true,
    slashCommands: true,
    allowedTools: [...READ_ONLY, "Skill"],
    steps: [{ prompt: "Use the iris-note skill to tell me the Iris answer." }],
    expect: { turns: 1, saw: ["tool:Skill", "request:skill-note"] },
  },
  {
    id: "codex-skill",
    harness: "codex",
    about: "A repository skill (.agents/skills), mentioned explicitly with $iris-note",
    skill: true,
    steps: [{ prompt: "$iris-note Tell me the Iris answer." }],
    expect: { turns: 1, saw: ["request:skill-note"] },
  },
  {
    id: "claude-plugin",
    harness: "claude",
    about: "A skill from a plugin (--plugin-dir), named plugin:skill",
    plugin: true,
    slashCommands: true,
    allowedTools: [...READ_ONLY, "Skill"],
    steps: [{ prompt: "Use the plugin-note skill from the iris-plugin plugin to tell me the Iris plugin answer." }],
    expect: { turns: 1, saw: ["tool:Skill", "request:plugin-note"] },
  },
  {
    id: "codex-plugin",
    harness: "codex",
    about: "A skill from a plugin installed from a local marketplace",
    plugin: true,
    steps: [{ prompt: "Use the plugin-note skill from the iris-plugin plugin to tell me the Iris plugin answer." }],
    expect: { turns: 1, saw: ["request:plugin-note"] },
  },
  {
    id: "claude-web-search",
    harness: "claude",
    about: "WebSearch: an inner call with a server tool; it must not split the turn",
    allowedTools: ["WebSearch"],
    steps: [{ prompt: "Search the web for the current Node.js LTS version and tell me what it is." }],
    expect: { turns: 1, saw: ["block:server_tool_use", "block:web_search_tool_result"] },
  },
  {
    id: "codex-web-search",
    harness: "codex",
    about: "Web search on the built-in provider: a separate POST /alpha/search call, after failed WebSocket attempts",
    codexConfig: ['web_search="live"'],
    codexBuiltinProvider: true,
    steps: [{ prompt: "Search the web for the current Node.js LTS version and tell me what it is. Use your web search tool, not shell commands." }],
    // On its built-in provider Codex first tries a Responses WebSocket
    // (GET /responses). The gateway does not proxy WebSockets, so those
    // attempts fail with 405 and Codex falls back to HTTP streaming.
    expect: { turns: 1, saw: ["path:/alpha/search"], knownFailures: ["GET /responses"] },
  },
  {
    id: "claude-thinking",
    harness: "claude",
    about: "Thinking blocks: empty thinking deltas and signatures must not count as first token",
    effort: "high",
    steps: [{ prompt: PUZZLE }],
    expect: { turns: 1, saw: ["block:thinking", "delta:signature_delta"] },
  },
  {
    id: "codex-thinking",
    harness: "codex",
    about: "Reasoning items and reasoning summaries in the stream",
    codexConfig: ['model_reasoning_effort="high"', 'model_reasoning_summary="detailed"'],
    steps: [{ prompt: FIND_BREAKS }],
    expect: { turns: 1, saw: ["item:reasoning"] },
  },
  {
    id: "claude-dropped-stream",
    harness: "claude",
    about: "Gap 5: the connection drops mid-answer; the harness's retry stays in the turn",
    fault: { action: "cut", afterTextDeltas: 40 },
    steps: [{ prompt: LONG_ANSWER }, { prompt: "continue", continue: true }],
    expect: { turns: 2, incomplete: { upstream_dropped: 1 } },
  },
  {
    id: "codex-dropped-stream",
    harness: "codex",
    about: "The connection drops mid-answer; Codex retries within its turn",
    fault: { action: "cut", afterTextDeltas: 40 },
    steps: [{ prompt: LONG_ANSWER }, { prompt: "continue", continue: true }],
    expect: { turns: 2, incomplete: { upstream_dropped: 1 } },
  },
  {
    id: "claude-interrupt",
    harness: "claude",
    about: "The user stops the harness mid-answer (Ctrl+C): client_aborted, with estimated tokens",
    fault: { action: "interrupt", afterTextDeltas: 40 },
    steps: [{ prompt: LONG_ANSWER }],
    expect: { turns: 1, incomplete: { client_aborted: 1 } },
  },
  {
    id: "codex-interrupt",
    harness: "codex",
    about: "The user stops the harness mid-answer (Ctrl+C): client_aborted, with estimated tokens",
    fault: { action: "interrupt", afterTextDeltas: 40 },
    steps: [{ prompt: LONG_ANSWER }],
    expect: { turns: 1, incomplete: { client_aborted: 1 } },
  },
];
