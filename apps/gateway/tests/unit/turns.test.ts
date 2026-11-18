import type { RequestInfo } from "@seeit/core";
import { describe, expect, it } from "vitest";
import { createTurnTracker } from "../../src/turns.ts";

const call = (extra: Partial<RequestInfo> = {}): RequestInfo => ({
  harnessVersion: "claude-cli/2.1.326",
  sessionId: "s1",
  explicitTurnId: null,
  agentId: null,
  kind: "turn",
  startsNewTurn: false,
  turnKey: null,
  model: "claude-opus-5-5",
  context: { toolsCount: 1, toolsChars: 10, instructionsChars: 10 },
  ...extra,
});
const prompt = (turnKey: string) => call({ startsNewTurn: true, turnKey });

describe("turn tracker (Claude: turns are inferred)", () => {
  it("keeps tool-loop calls in the turn and starts a new one for a new prompt", () => {
    const turns = createTurnTracker();
    const first = turns.turnFor(prompt("0:a"));
    expect(turns.turnFor(call())).toBe(first);
    const second = turns.turnFor(prompt("2:b"));
    expect(second).not.toBe(first);
    expect(turns.turnFor(call())).toBe(second);
  });

  // Seen live: after a dropped stream Claude Code re-sends the same request,
  // or the same prompt with a "resume" block added (key "0:a,b").
  it("keeps a retry or resume of the same prompt in its turn", () => {
    const turns = createTurnTracker();
    const first = turns.turnFor(prompt("0:a"));
    expect(turns.turnFor(prompt("0:a"))).toBe(first);
    expect(turns.turnFor(prompt("0:a,b"))).toBe(first);
    // A second resume of the same turn still matches the turn's first key.
    expect(turns.turnFor(prompt("0:a,c"))).toBe(first);
    expect(turns.turnFor(prompt("0:z"))).not.toBe(first);
  });

  // Subagent rule: a subagent's calls belong to the turn that started it.
  it("puts subagent calls in the current turn, and they never start one", () => {
    const turns = createTurnTracker();
    const main = turns.turnFor(prompt("0:a"));
    // The subagent's first request ends in new user text (its task).
    expect(turns.turnFor(call({ agentId: "agent-1", startsNewTurn: true, turnKey: "0:task" }))).toBe(main);
    expect(turns.turnFor(call({ agentId: "agent-1" }))).toBe(main);
    // The main loop continues with the subagent's result: still the same turn.
    expect(turns.turnFor(call())).toBe(main);
  });

  // Linking by session: a tool's own model calls (WebSearch's page reader,
  // seen live with 56k input tokens) carry nothing but the session ID.
  it("links a background call to the turn in progress in its session", () => {
    const turns = createTurnTracker();
    // Before any turn (the startup quota probe): nothing to link to.
    expect(turns.turnFor(call({ kind: "background" }))).toBeNull();
    const main = turns.turnFor(prompt("0:a"));
    expect(turns.turnFor(call({ kind: "background" }))).toBe(main);
    // It never starts or changes a turn.
    expect(turns.turnFor(call({ kind: "background", startsNewTurn: true, turnKey: "9:x" }))).toBe(main);
    expect(turns.turnFor(call())).toBe(main);
  });

  it("does not link calls without a session ID, or connectivity checks", () => {
    const turns = createTurnTracker();
    turns.turnFor(prompt("0:a"));
    expect(turns.turnFor(call({ kind: "background", sessionId: null }))).toBeNull();
    expect(turns.turnFor(call({ kind: "connectivity" }))).toBeNull();
  });

  // A turn call that cannot start a turn (only server tools): joins the current one.
  it("keeps a server-tool-only call in the turn in progress", () => {
    const turns = createTurnTracker();
    const main = turns.turnFor(prompt("0:a"));
    expect(turns.turnFor(call({ startsNewTurn: false }))).toBe(main);
  });

  it("uses the harness's own turn ID when it sends one (Codex)", () => {
    const turns = createTurnTracker();
    expect(turns.turnFor(call({ explicitTurnId: "codex-turn-7" }))).toBe("codex-turn-7");
    // Codex's web search runs as a separate background call (POST /alpha/search).
    expect(turns.turnFor(call({ kind: "background" }))).toBe("codex-turn-7");
  });

  it("keeps sessions apart", () => {
    const turns = createTurnTracker();
    expect(turns.turnFor(prompt("0:a"))).not.toBe(turns.turnFor(call({ sessionId: "s2", startsNewTurn: true, turnKey: "0:a" })));
  });
});
