// Tool labels shared by every harness (ADR 0009, tool_uses): kind, target,
// and plugin from a tool name, and the size of a tool result.

import type { ToolUse } from "../records.ts";
import { isObject, type Json } from "./model.ts";

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Kind, target, and plugin from a tool name (and, for Skill and Agent, one input field). */
export function classify(name: string, input: Json = {}): Pick<ToolUse, "kind" | "name" | "target" | "plugin"> {
  // Plugin skills and agents are named "<plugin>:<name>".
  const pluginOf = (target: string | null) => (target?.includes(":") ? target.split(":")[0]! : null);
  if (name === "Skill") {
    const target = str(input.skill);
    return { kind: "skill", name, target, plugin: pluginOf(target) };
  }
  if (name === "Agent" || name === "Task") {
    const target = str(input.subagent_type);
    return { kind: "agent", name, target, plugin: pluginOf(target) };
  }
  // mcp__<server>__<tool>; a plugin's server is mcp__plugin_<plugin>_<server>__<tool>.
  const mcp = name.match(/^mcp__(.+?)__/);
  if (mcp) {
    const plugin = mcp[1]!.match(/^plugin_([^_]+)_(.+)$/);
    return { kind: "mcp", name, target: plugin ? plugin[2]! : mcp[1]!, plugin: plugin ? plugin[1]! : null };
  }
  return { kind: "builtin", name, target: null, plugin: null };
}

/** Characters of text in a content value: a string, or blocks (text blocks count their text; others their JSON). */
export function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return content === undefined ? 0 : JSON.stringify(content).length;
  return content.reduce((n: number, b: unknown) => n + (isObject(b) && typeof b.text === "string" ? b.text.length : JSON.stringify(b).length), 0);
}
