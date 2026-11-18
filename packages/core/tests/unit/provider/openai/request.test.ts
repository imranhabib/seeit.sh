import { describe, expect, it } from "vitest";
import { readRequest } from "../../../../src/provider/index.ts";

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
