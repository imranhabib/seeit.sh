import { describe, expect, it } from "vitest";
import { readRequest, resendsTurnStart } from "./request.ts";

const tool = { name: "Read", description: "Read a file", input_schema: { type: "object" } };

function claude(body: object, headers: Record<string, string> = {}) {
  return readRequest("claude", {
    method: "POST",
    path: "/v1/messages?beta=true",
    headers: new Headers({ "user-agent": "claude-cli/2.1.322 (external, cli)", ...headers }),
    body,
  });
}

describe("readRequest: claude", () => {
  it("reads version, session, model, and context size", () => {
    const info = claude(
      { model: "claude-opus-5-5", system: [{ type: "text", text: "You are Claude Code." }], tools: [tool], messages: [{ role: "user", content: "hi" }] },
      { "x-claude-code-session-id": "s1" },
    );
    expect(info).toMatchObject({ harnessVersion: "claude-cli/2.1.322", sessionId: "s1", model: "claude-opus-5-5", kind: "turn" });
    expect(info.context.toolsCount).toBe(1);
    expect(info.context.toolsChars).toBeGreaterThan(0);
    expect(info.context.instructionsChars).toBeGreaterThan(0);
  });

  it("falls back to the session ID in body metadata", () => {
    const info = claude({ tools: [tool], messages: [], metadata: { user_id: JSON.stringify({ session_id: "s2" }) } });
    expect(info.sessionId).toBe("s2");
  });

  it("starts a new turn when the user typed text", () => {
    expect(claude({ tools: [tool], messages: [{ role: "user", content: "hi" }] }).startsNewTurn).toBe(true);
    expect(claude({ tools: [tool], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }).startsNewTurn).toBe(true);
  });

  it("stays in the same turn for tool results, even with extra text blocks", () => {
    const content = [
      { type: "tool_result", tool_use_id: "t1", content: "file contents" },
      { type: "text", text: "<system-reminder>...</system-reminder>" },
    ];
    expect(claude({ tools: [tool], messages: [{ role: "user", content }] }).startsNewTurn).toBe(false);
  });

  it("labels calls without tools as background (the startup quota probe)", () => {
    const info = claude({ model: "claude-opus-5-5", max_tokens: 1, messages: [{ role: "user", content: "quota" }] });
    expect(info.kind).toBe("background");
    expect(info.startsNewTurn).toBe(false);
  });

  // PLAN.md, live-run finding 1: 2.1.133 sends HEAD /claude (empty path), 2.1.311
  // sends HEAD /api/hello. Both carry the Bun runtime's user-agent.
  it.each(["", "/api/hello"])("labels HEAD %j as a connectivity check with no harness version", (path) => {
    const info = readRequest("claude", { method: "HEAD", path, headers: new Headers({ "user-agent": "Bun/1.4.4" }), body: null });
    expect(info).toMatchObject({ kind: "connectivity", harnessVersion: null, startsNewTurn: false });
  });

  it("labels other non-messages endpoints as background", () => {
    const info = readRequest("claude", { method: "GET", path: "/v1/models", headers: new Headers({ "user-agent": "claude-cli/2.1.311 (external, cli)" }), body: null });
    expect(info).toMatchObject({ kind: "background", harnessVersion: "claude-cli/2.1.311" });
  });

  it("takes the version only from Claude Code's own user-agent", () => {
    expect(claude({ tools: [tool], messages: [] }, { "user-agent": "Bun/1.3.14" }).harnessVersion).toBeNull();
    expect(claude({ tools: [tool], messages: [] }, { "user-agent": "codex_exec/0.169.0" }).harnessVersion).toBeNull();
  });
});

// Shapes below were seen live with Claude Code 2.1.326 (Iris run, 2026-11-17).
describe("readRequest: claude 2.1.326 request shapes", () => {
  const system = { role: "system", content: [{ type: "text", text: "# Environment\nYou have been invoked in ..." }] };
  const prompt = { role: "user", content: [{ type: "text", text: "<system-reminder>...</system-reminder>" }, { type: "text", text: "Explain src/math.js" }] };

  it("finds new user text behind trailing system messages", () => {
    expect(claude({ tools: [tool], messages: [prompt, system] }).startsNewTurn).toBe(true);
    expect(claude({ tools: [tool], messages: [prompt, system, system] }).startsNewTurn).toBe(true);
  });

  it("stays in the turn when a system message follows a tool result", () => {
    const messages = [prompt, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }] }, system];
    expect(claude({ tools: [tool], messages }).startsNewTurn).toBe(false);
  });

  // A background subagent reports back through a user message that holds only
  // system reminders ("[SYSTEM NOTIFICATION - NOT USER INPUT] ...").
  it("does not treat a message of only system reminders as a user prompt", () => {
    const note = { type: "text", text: "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event...\n</system-reminder>" };
    const earlier = [prompt, { role: "assistant", content: [{ type: "text", text: "Started two agents." }] }];
    expect(claude({ tools: [tool], messages: [...earlier, { role: "user", content: [note] }] })).toMatchObject({ startsNewTurn: false, turnKey: null });
    expect(claude({ tools: [tool], messages: [...earlier, { role: "user", content: [note, note] }, system] }).startsNewTurn).toBe(false);
    expect(claude({ tools: [tool], messages: [...earlier, { role: "user", content: "  <system-reminder>note</system-reminder>" }] }).startsNewTurn).toBe(false);
    // Reminders next to real text: the user typed something.
    expect(claude({ tools: [tool], messages: [...earlier, { role: "user", content: [note, { type: "text", text: "thanks" }] }] }).startsNewTurn).toBe(true);
  });

  // The WebSearch tool makes its own model call with only a server tool. It is
  // part of the turn's work, but its "Perform a web search ..." message is not
  // a prompt the user typed, so it must not start a turn.
  it("labels a call with only server tools as a turn call that cannot start a turn", () => {
    const info = claude({ tools: [{ type: "web_search_20250305", name: "web_search" }], messages: [{ role: "user", content: [{ type: "text", text: "Perform a web search for the query: node lts" }] }] });
    expect(info).toMatchObject({ kind: "turn", startsNewTurn: false, turnKey: null });
    // No tools at all (quota probe, session title, WebSearch's page reader): background.
    expect(claude({ tools: [], messages: [prompt] }).kind).toBe("background");
    // An explicit "custom" type is still a client tool.
    expect(claude({ tools: [{ type: "custom", name: "Read" }], messages: [prompt] }).kind).toBe("turn");
  });

  it("reads the subagent ID from x-claude-code-agent-id", () => {
    expect(claude({ tools: [tool], messages: [prompt] }, { "x-claude-code-agent-id": "aab45a62da5615b35" }).agentId).toBe("aab45a62da5615b35");
    expect(claude({ tools: [tool], messages: [prompt] }).agentId).toBeNull();
  });

  // After a dropped stream, Claude Code sends the identical request again.
  it("gives a retry the same turn key, and a later prompt a different one", () => {
    const first = claude({ tools: [tool], messages: [prompt, system] });
    const retry = claude({ tools: [tool], messages: [prompt, system] });
    const next = claude({ tools: [tool], messages: [prompt, { role: "assistant", content: [{ type: "text", text: "..." }] }, prompt] });
    expect(first.turnKey).toBeTruthy();
    expect(retry.turnKey).toBe(first.turnKey);
    // Same text typed again later is a new prompt: its position differs.
    expect(next.turnKey).not.toBe(first.turnKey);
    expect(resendsTurnStart(first.turnKey, retry.turnKey)).toBe(true);
    expect(resendsTurnStart(first.turnKey, next.turnKey)).toBe(false);
    // Calls that do not start a turn have no key.
    expect(claude({ tools: [tool], messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "" }] }] }).turnKey).toBeNull();
  });
});

// Seen live (Iris run, 2026-11-17): after a stream is cut mid-answer, Claude
// Code 2.1.326 re-sends the prompt with one text block added at the end
// ("Your response above was cut off mid-stream. Resume directly ...").
// cache_control moves to the new last block.
describe("resendsTurnStart", () => {
  const reminder = { type: "text", text: "<system-reminder>...</system-reminder>" };
  const ask = (extra: object = {}) => ({ type: "text", text: "Write a long explanation", ...extra });
  const key = (content: unknown, before: object[] = []) => claude({ tools: [tool], messages: [...before, { role: "user", content }] }).turnKey;

  it("matches a resume that appends a block to the same message", () => {
    const original = key([reminder, ask({ cache_control: { type: "ephemeral", ttl: "1h" } })]);
    // The resume also gains a newline at the end of the prompt block.
    const resume = key([reminder, ask({ text: "Write a long explanation\n" }), { type: "text", text: "Your response above was cut off mid-stream.", cache_control: { type: "ephemeral", ttl: "1h" } }]);
    expect(resendsTurnStart(original, resume)).toBe(true);
  });

  it("does not match another prompt at the same position (for example after /clear)", () => {
    expect(resendsTurnStart(key([reminder, ask()]), key([reminder, { type: "text", text: "Something else" }]))).toBe(false);
    expect(resendsTurnStart(key("first prompt"), key("second prompt"))).toBe(false);
  });

  it("does not match the same prompt at a later position", () => {
    const earlier = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    expect(resendsTurnStart(key("continue"), key("continue", earlier))).toBe(false);
  });

  it("does not match when either side has no key", () => {
    expect(resendsTurnStart(null, key("hi"))).toBe(false);
    expect(resendsTurnStart(key("hi"), null)).toBe(false);
  });
});

describe("readRequest: codex", () => {
  const turnMeta = JSON.stringify({ session_id: "c1", turn_id: "t9", request_kind: "turn" });
  const headers = (ua: string) => new Headers({ "user-agent": ua, "session-id": "c1", "x-codex-turn-metadata": turnMeta });

  it("reads tools and instructions from top-level fields (Codex 0.153)", () => {
    const info = readRequest("codex", {
      method: "POST",
      path: "/responses",
      headers: headers("codex_exec/0.153.4 (Mac OS 26.5.1; arm64)"),
      body: { model: "gpt-6.1-sol", instructions: "You are Codex.", tools: [{ type: "function", name: "a" }, { type: "function", name: "b" }], input: [] },
    });
    expect(info).toMatchObject({ harnessVersion: "codex_exec/0.153.4", sessionId: "c1", explicitTurnId: "t9", kind: "turn" });
    expect(info.context).toMatchObject({ toolsCount: 2, instructionsChars: "You are Codex.".length });
  });

  it("reads tools and instructions from input items (Codex 0.169)", () => {
    const info = readRequest("codex", {
      method: "POST",
      path: "/responses",
      headers: headers("Codex Desktop/0.169.0-alpha.11.1 (Mac OS 26.5.1; arm64)"),
      body: {
        model: "gpt-6.1-sol",
        input: [
          { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "functions", tools: [{ name: "a" }, { name: "b" }, { name: "c" }] }, { type: "web_search" }] },
          { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex." }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "pong" }] },
        ],
      },
    });
    expect(info.harnessVersion).toBe("Codex Desktop/0.169.0-alpha.11.1");
    expect(info.context.toolsCount).toBe(4); // 3 in the namespace + web_search
    expect(info.context.instructionsChars).toBeGreaterThan(0);
  });

  it("labels the /models call as background", () => {
    const info = readRequest("codex", { method: "GET", path: "/models?client_version=0.169.0", headers: headers("codex_exec/0.169.0"), body: null });
    expect(info.kind).toBe("background");
  });

  // Seen live with codex_exec 0.169.0 and spawn_agent (Iris run, 2026-11-17):
  // a spawned agent keeps the session ID but sends its own turn_id and thread_id.
  it("puts a spawned agent's calls in the user's turn and keeps its thread ID", () => {
    const meta = (extra: object) => new Headers({ "user-agent": "codex_exec/0.169.0", "session-id": "c1", "x-codex-turn-metadata": JSON.stringify({ session_id: "c1", request_kind: "turn", root_turn_id: "turn-root", ...extra }) });
    const body = { model: "gpt-6.1-sol", input: [] };
    const parent = readRequest("codex", { method: "POST", path: "/responses", headers: meta({ turn_id: "turn-root", thread_id: "c1", thread_source: "user" }), body });
    const child = readRequest("codex", {
      method: "POST",
      path: "/responses",
      headers: meta({ turn_id: "turn-child", thread_id: "thread-child", parent_thread_id: "c1", thread_source: "subagent", subagent_kind: "thread_spawn" }),
      body,
    });
    expect(parent).toMatchObject({ explicitTurnId: "turn-root", agentId: null, kind: "turn" });
    expect(child).toMatchObject({ explicitTurnId: "turn-root", agentId: "thread-child", kind: "turn", sessionId: "c1" });
  });

  it("falls back to turn_id when there is no root_turn_id (older Codex)", () => {
    const h = new Headers({ "user-agent": "codex_exec/0.153.4", "x-codex-turn-metadata": JSON.stringify({ turn_id: "t9", request_kind: "turn" }) });
    expect(readRequest("codex", { method: "POST", path: "/responses", headers: h, body: {} }).explicitTurnId).toBe("t9");
  });

  it("takes the version only from a Codex user-agent", () => {
    // codex_cli_rs is the interactive Codex CLI's originator name.
    expect(readRequest("codex", { method: "GET", path: "/models", headers: headers("codex_cli_rs/0.169.0 (Mac OS 26.5.1; arm64)"), body: null }).harnessVersion).toBe(
      "codex_cli_rs/0.169.0",
    );
    expect(readRequest("codex", { method: "GET", path: "/models", headers: headers("node/24.1.0"), body: null }).harnessVersion).toBeNull();
  });
});
