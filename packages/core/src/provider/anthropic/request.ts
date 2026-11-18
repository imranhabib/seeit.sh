// Claude Code requests (Anthropic Messages API): kind, session, subagent,
// and turn start. Claude Code sends no turn ID, so the turn start is
// inferred here and used by the gateway's turn tracker (apps/gateway/src/turns.ts).

import { createHash } from "node:crypto";
import { isObject, type CallKind, type Json, type RequestInfo } from "../model.ts";

/** Claude Code's own product name in the user-agent ("claude-cli/2.1.326"). */
export const CLAUDE_PRODUCT = /^claude-cli$/;

export function readClaudeRequest(method: string, path: string, headers: Headers, body: Json, harnessVersion: string | null): RequestInfo {
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
