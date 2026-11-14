// What the gateway reads from a request before forwarding it.
//
// Harnesses change their request format between versions without notice
// (see PLAN.md, "Version-tolerant parsing"), so every lookup here tolerates
// missing fields and checks every place a value is known to live.

export type Harness = "claude" | "codex";
export type CallKind = "turn" | "background";

export type RequestInfo = {
  /** "claude-cli/2.1.322", "codex_exec/0.169.0", "Codex Desktop/0.169.0-alpha.11.1" */
  harnessVersion: string | null;
  sessionId: string | null;
  /** Turn ID sent by the harness (Codex). Claude sends none; see startsNewTurn. */
  explicitTurnId: string | null;
  kind: CallKind;
  /** Claude only: true when this call starts a new user turn (inferred). */
  startsNewTurn: boolean;
  model: string | null;
  context: ContextShape;
};

/** Size of the fixed parts of the prompt. Phase 2 builds feature A on this. */
export type ContextShape = {
  toolsCount: number;
  toolsChars: number;
  instructionsChars: number;
};

type Json = Record<string, any>;

export function readRequest(
  harness: Harness,
  req: { method: string; path: string; headers: Headers; body: unknown },
): RequestInfo {
  const body: Json = isObject(req.body) ? req.body : {};
  const harnessVersion = req.headers.get("user-agent")?.match(/^(.+?\/\S+)/)?.[1] ?? null;
  return harness === "claude"
    ? readClaude(req.method, req.path, req.headers, body, harnessVersion)
    : readCodex(req.method, req.path, req.headers, body, harnessVersion);
}

function readClaude(method: string, path: string, headers: Headers, body: Json, harnessVersion: string | null): RequestInfo {
  const tools: unknown[] = Array.isArray(body.tools) ? body.tools : [];
  const isMessages = method === "POST" && /^\/v1\/messages(\?|$)/.test(path);
  // Heuristic: the main agent loop always sends tools. Calls without tools are
  // side requests (the startup "quota" probe, title generation, ...).
  const kind: CallKind = isMessages && tools.length > 0 ? "turn" : "background";

  return {
    harnessVersion,
    sessionId: headers.get("x-claude-code-session-id") ?? sessionFromMetadata(body.metadata?.user_id),
    explicitTurnId: null,
    kind,
    startsNewTurn: kind === "turn" && lastMessageIsNewUserText(body.messages),
    model: typeof body.model === "string" ? body.model : null,
    context: {
      toolsCount: tools.length,
      toolsChars: tools.length ? JSON.stringify(tools).length : 0,
      instructionsChars: body.system ? JSON.stringify(body.system).length : 0,
    },
  };
}

// A new turn starts when the user typed something. In the tool loop the last
// message is a user message holding tool_result blocks (sometimes with extra
// text such as system reminders), so any tool_result means "same turn".
function lastMessageIsNewUserText(messages: unknown): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1];
  if (last?.role !== "user") return false;
  if (typeof last.content === "string") return true;
  if (!Array.isArray(last.content)) return false;
  return !last.content.some((b: Json) => b?.type === "tool_result");
}

function sessionFromMetadata(userId: unknown): string | null {
  if (typeof userId !== "string") return null;
  try {
    return JSON.parse(userId).session_id ?? null;
  } catch {
    return null;
  }
}

function readCodex(method: string, path: string, headers: Headers, body: Json, harnessVersion: string | null): RequestInfo {
  const turnMeta = parseJson(headers.get("x-codex-turn-metadata")) ?? parseJson(body.client_metadata?.["x-codex-turn-metadata"]) ?? {};
  const isResponses = method === "POST" && /^\/responses(\?|$)/.test(path);
  const requestKind = turnMeta.request_kind;
  const kind: CallKind = isResponses && (requestKind === undefined || requestKind === "turn") ? "turn" : "background";

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
    explicitTurnId: turnMeta.turn_id ?? null,
    kind,
    startsNewTurn: false,
    model: typeof body.model === "string" ? body.model : null,
    context: {
      toolsCount,
      toolsChars: tools.length ? JSON.stringify(tools).length : 0,
      instructionsChars,
    },
  };
}

function parseJson(text: unknown): Json | null {
  if (typeof text !== "string") return null;
  try {
    const v = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
