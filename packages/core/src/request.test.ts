import { describe, expect, it } from "vitest";
import { readRequest } from "./request.ts";

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

  it("labels non-messages endpoints as background", () => {
    const info = readRequest("claude", { method: "HEAD", path: "/api/hello", headers: new Headers({ "user-agent": "Bun/1.4.4" }), body: null });
    expect(info).toMatchObject({ kind: "background", harnessVersion: "Bun/1.4.4" });
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
});
