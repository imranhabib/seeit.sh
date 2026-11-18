// Codex requests (OpenAI Responses API): kind, session, turn, and subagent.
// Codex names its turns in the x-codex-turn-metadata header, so nothing has
// to be inferred.

import { parseJson, type CallKind, type Json, type RequestInfo } from "../model.ts";

/** Codex's product names in the user-agent: codex_exec, codex_cli_rs, Codex Desktop, ... */
export const CODEX_PRODUCT = /^codex/i;

export function readCodexRequest(method: string, path: string, headers: Headers, body: Json, harnessVersion: string | null): RequestInfo {
  const turnMeta = parseJson(headers.get("x-codex-turn-metadata")) ?? parseJson(body.client_metadata?.["x-codex-turn-metadata"]) ?? {};
  const isResponses = method === "POST" && /^\/responses(\?|$)/.test(path);
  const requestKind = turnMeta.request_kind;
  const kind: CallKind =
    method === "HEAD" ? "connectivity" : isResponses && (requestKind === undefined || requestKind === "turn") ? "turn" : "background";

  // Tools: top-level `tools` (older Codex) or an `additional_tools` input item
  // (Codex 0.169+). Tools may be grouped into namespaces.
  const input: Json[] = Array.isArray(body.input) ? body.input : [];
  const toolItems = input.filter((i) => i?.type === "additional_tools");
  const tools: Json[] = [...(Array.isArray(body.tools) ? body.tools : []), ...toolItems.flatMap((i) => i.tools ?? [])];
  const toolsCount = tools.reduce((n, t) => n + (t?.type === "namespace" && Array.isArray(t.tools) ? t.tools.length : 1), 0);

  // Instructions: top-level `instructions` (older) or developer messages in input (0.169+).
  const developer = input.filter((i) => i?.type === "message" && i.role === "developer");
  const instructionsChars =
    (typeof body.instructions === "string" ? body.instructions.length : 0) +
    (developer.length ? JSON.stringify(developer).length : 0);

  return {
    harnessVersion,
    sessionId: headers.get("session-id") ?? turnMeta.session_id ?? null,
    // A spawned agent (spawn_agent) sends its own turn_id; root_turn_id names
    // the user's turn it works for. Using it keeps one prompt in one turn,
    // the same rule as for Claude Code subagents.
    explicitTurnId: turnMeta.root_turn_id ?? turnMeta.turn_id ?? null,
    // The agent's thread ID, for calls made by a spawned agent only.
    agentId: turnMeta.parent_thread_id ? (turnMeta.thread_id ?? null) : null,
    kind,
    startsNewTurn: false,
    turnKey: null,
    model: typeof body.model === "string" ? body.model : null,
    context: {
      toolsCount,
      toolsChars: tools.length ? JSON.stringify(tools).length : 0,
      instructionsChars,
    },
  };
}
