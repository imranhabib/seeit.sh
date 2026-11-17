// What the gateway reads from a request before forwarding it.
//
// Harnesses change their request format between versions without notice
// (see PLAN.md, "Version-tolerant parsing"), so every lookup here tolerates
// missing fields and checks every place a value is known to live.

import { createHash } from "node:crypto";

export type Harness = "claude" | "codex";
/**
 * turn: part of a prompt the user typed. background: a side request (quota
 * probe, title, model list). connectivity: a HEAD request that only checks the
 * gateway and upstream can be reached; it uses no tokens.
 */
export type CallKind = "turn" | "background" | "connectivity";

export type RequestInfo = {
  /**
   * "claude-cli/2.1.322", "codex_exec/0.169.0", "Codex Desktop/0.169.0-alpha.11.1".
   * Null when the user-agent is not the harness's own (for example "Bun/1.4.4").
   */
  harnessVersion: string | null;
  sessionId: string | null;
  /** Turn ID sent by the harness (Codex). Claude sends none; see startsNewTurn. */
  explicitTurnId: string | null;
  /**
   * Subagent ID; null for the main agent. Claude Code: x-claude-code-agent-id.
   * Codex: the spawned agent's thread_id from the turn metadata.
   */
  agentId: string | null;
  kind: CallKind;
  /** Claude only: true when this call starts a new user turn (inferred). */
  startsNewTurn: boolean;
  /**
   * Claude only, set when startsNewTurn: identifies the user message that
   * starts the turn, as "<position>:<hash of block 1>,<hash of block 2>,...".
   * After a failed call the harness sends that message again; compare keys
   * with resendsTurnStart so the turn tracker keeps such a call in its turn.
   */
  turnKey: string | null;
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
  const harnessVersion = harnessVersionFrom(harness, req.headers.get("user-agent"));
  return harness === "claude"
    ? readClaude(req.method, req.path, req.headers, body, harnessVersion)
    : readCodex(req.method, req.path, req.headers, body, harnessVersion);
}

// The user-agent starts with "product/version". Some requests carry a runtime's
// user-agent instead (Claude Code's connectivity check sends "Bun/1.4.4"), and
// storing that as the harness version would hide which harness version sent
// the call (PLAN.md, live-run finding 1). So keep it only when the product
// name belongs to the harness.
const HARNESS_PRODUCT: Record<Harness, RegExp> = {
  claude: /^claude-cli$/,
  codex: /^codex/i, // codex_exec, codex_cli_rs, Codex Desktop, ...
};

function harnessVersionFrom(harness: Harness, userAgent: string | null): string | null {
  const match = userAgent?.match(/^(.+?)\/(\S+)/);
  if (!match || !HARNESS_PRODUCT[harness].test(match[1]!)) return null;
  return `${match[1]}/${match[2]}`;
}

function readClaude(method: string, path: string, headers: Headers, body: Json, harnessVersion: string | null): RequestInfo {
  const tools: Json[] = Array.isArray(body.tools) ? body.tools : [];
  const isMessages = method === "POST" && /^\/v1\/messages(\?|$)/.test(path);
  // Which calls are turn calls:
  // - The agent loop always offers its own (client) tools: Read, Bash, ...
  //   They have no `type`, or type "custom".
  // - A tool can make its own model call with only a server tool (typed,
  //   for example "web_search_20250305"): Claude Code's WebSearch does. It is
  //   part of the turn's work, so it is a turn call too.
  // - Calls with no tools at all are side requests: the startup "quota"
  //   probe, the session title, WebSearch's page reader. They are background;
  //   the turn tracker still links them to the session's turn in progress.
  const hasClientTool = tools.some((t) => t?.type === undefined || t.type === "custom");
  const hasServerTool = tools.some((t) => typeof t?.type === "string" && t.type !== "custom");
  const kind: CallKind = method === "HEAD" ? "connectivity" : isMessages && (hasClientTool || hasServerTool) ? "turn" : "background";
  // Only the agent loop can start a turn. A server-tool-only call ends in a
  // message the tool wrote ("Perform a web search for ..."), not the user.
  const newPrompt = kind === "turn" && hasClientTool ? newUserText(body.messages) : null;

  return {
    harnessVersion,
    sessionId: headers.get("x-claude-code-session-id") ?? sessionFromMetadata(body.metadata?.user_id),
    explicitTurnId: null,
    agentId: headers.get("x-claude-code-agent-id"),
    kind,
    startsNewTurn: newPrompt !== null,
    turnKey: newPrompt,
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
//
// Claude Code 2.1.326 also puts `role: "system"` messages in the list, often
// last (environment notes, newly available tools). They are not part of the
// conversation, so look at the last message that is.
//
// Returns the turn key (see RequestInfo.turnKey) when the request ends in new
// user text, otherwise null.
function newUserText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  let i = messages.length - 1;
  while (i >= 0 && messages[i]?.role === "system") i--;
  const last = messages[i];
  if (last?.role !== "user") return null;
  const blocks: unknown[] = Array.isArray(last.content) ? last.content : [last.content];
  if (blocks.some((b) => isObject(b) && b.type === "tool_result")) return null;
  // The harness also writes user messages itself, wrapped in
  // <system-reminder>: for example when a background subagent finishes
  // ("[SYSTEM NOTIFICATION - NOT USER INPUT]"). A message with nothing but
  // reminders was not typed by the user.
  const texts = blocks.map((b) => (typeof b === "string" ? b : isObject(b) && typeof b.text === "string" ? b.text : null));
  const userTyped = texts.some((t) => t !== null && !t.trimStart().startsWith("<system-reminder>"));
  if (!userTyped) return null;
  // Position + one hash per content block (see resendsTurnStart).
  return `${i}:${blocks.map(blockHash).join(",")}`;
}

// Two details change on a block when the harness sends the message again
// with another block added, so both are left out of the hash: cache_control
// (Claude Code moves it to the last block) and whitespace at the end of the
// text (the resume adds a newline to the prompt).
function blockHash(block: unknown): string {
  const { cache_control: _ignored, ...rest } = isObject(block) ? block : { text: block };
  if (typeof rest.text === "string") rest.text = rest.text.trimEnd();
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 12);
}

/**
 * True when `next` sends the message that started the current turn again:
 * the same position, and the same content blocks, possibly with more added.
 *
 * Seen live with Claude Code 2.1.326: after a dropped stream it re-sends the
 * identical request, and after a stream cut mid-answer it adds one text block
 * ("Your response above was cut off mid-stream. Resume directly ...").
 * Another prompt at the same position (after /clear) or the same text at a
 * later position is a new turn.
 */
export function resendsTurnStart(startedBy: string | null, next: string | null): boolean {
  if (!startedBy || !next) return false;
  return next === startedBy || next.startsWith(startedBy + ",");
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
