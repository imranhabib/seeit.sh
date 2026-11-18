// Picks the provider-specific code for a harness or provider. The rest of
// the repository imports these through @seeit/core (src/index.ts).

import { QUOTA_HEADERS as ANTHROPIC_QUOTA_HEADERS } from "./anthropic/quota.ts";
import { createAnthropicInterpreter } from "./anthropic/stream.ts";
import { CLAUDE_PRODUCT, readClaudeRequest } from "./anthropic/request.ts";
import { fromAnthropicUsage } from "./anthropic/usage.ts";
import { isObject, type Harness, type Json, type Provider, type RequestInfo, type StreamInterpreter, type Usage } from "./model.ts";
import { QUOTA_HEADERS as OPENAI_QUOTA_HEADERS } from "./openai/quota.ts";
import { createOpenAIInterpreter } from "./openai/stream.ts";
import { CODEX_PRODUCT, readCodexRequest } from "./openai/request.ts";
import { fromOpenAIUsage } from "./openai/usage.ts";
import { harnessVersionFrom } from "./request.ts";

/** The API each harness talks to. */
export const PROVIDER_FOR: Readonly<Record<Harness, Provider>> = { claude: "anthropic", codex: "openai-responses" };

/**
 * What the gateway reads from a request before forwarding it.
 *
 * Harnesses change their request format between versions without notice
 * (see PLAN.md, "Version-tolerant parsing"), so every lookup tolerates
 * missing fields and checks every place a value is known to live.
 */
export function readRequest(
  harness: Harness,
  req: { method: string; path: string; headers: Headers; body: unknown },
): RequestInfo {
  const body: Json = isObject(req.body) ? req.body : {};
  const userAgent = req.headers.get("user-agent");
  return harness === "claude"
    ? readClaudeRequest(req.method, req.path, req.headers, body, harnessVersionFrom(CLAUDE_PRODUCT, userAgent))
    : readCodexRequest(req.method, req.path, req.headers, body, harnessVersionFrom(CODEX_PRODUCT, userAgent));
}

export function createInterpreter(provider: Provider): StreamInterpreter {
  return provider === "anthropic" ? createAnthropicInterpreter() : createOpenAIInterpreter();
}

/** Usage from a non-streaming JSON body (for example Claude's startup quota probe). */
export function usageFromJsonBody(harness: Harness, text: string): Usage | null {
  try {
    const usage = JSON.parse(text)?.usage;
    if (!usage || typeof usage !== "object") return null;
    return harness === "claude" ? fromAnthropicUsage(usage) : fromOpenAIUsage(usage);
  } catch {
    return null;
  }
}

// Patterns from every provider, so a quota header is kept whichever response
// it arrives on.
const QUOTA_HEADERS = [...ANTHROPIC_QUOTA_HEADERS, ...OPENAI_QUOTA_HEADERS];

/** Plan-quota headers, or null when the response has none (PLAN.md, Phase 2). */
export function quotaHeaders(headers: Headers): Record<string, string> | null {
  const quota: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (QUOTA_HEADERS.some((pattern) => pattern.test(name))) quota[name] = value;
  });
  return Object.keys(quota).length ? quota : null;
}
