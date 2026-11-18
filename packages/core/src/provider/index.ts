// Picks the provider-specific code for a harness or provider. The rest of
// the repository imports these through @seeit/core (src/index.ts).

import { createAnthropicInterpreter } from "./anthropic/stream.ts";
import { CLAUDE_PRODUCT, readClaudeRequest } from "./anthropic/request.ts";
import { isObject, type Harness, type Json, type Provider, type RequestInfo, type StreamInterpreter } from "./model.ts";
import { createOpenAIInterpreter } from "./openai/stream.ts";
import { CODEX_PRODUCT, readCodexRequest } from "./openai/request.ts";
import { harnessVersionFrom } from "./request.ts";

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
