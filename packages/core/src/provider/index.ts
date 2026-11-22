// Picks the provider-specific code for a harness or provider. The rest of
// the repository imports these through @seeit/core (src/index.ts).

import { NO_DETAILS, type CallDetails, type CallRecords } from "../records.ts";
import { requestPieces } from "../pieces.ts";
import { contextParts as claudeContextParts } from "./anthropic/context.ts";
import * as claudeDetails from "./anthropic/details.ts";
import { QUOTA_HEADERS as ANTHROPIC_QUOTA_HEADERS, quotaWindows as claudeQuotaWindows } from "./anthropic/quota.ts";
import { createAnthropicInterpreter } from "./anthropic/stream.ts";
import { CLAUDE_PRODUCT, readClaudeRequest } from "./anthropic/request.ts";
import { fromAnthropicUsage } from "./anthropic/usage.ts";
import { isObject, parseJson, type Harness, type Json, type Provider, type RequestInfo, type StreamInterpreter, type Usage } from "./model.ts";
import { contextParts as codexContextParts } from "./openai/context.ts";
import * as codexDetails from "./openai/details.ts";
import { QUOTA_HEADERS as OPENAI_QUOTA_HEADERS, quotaWindows as codexQuotaWindows } from "./openai/quota.ts";
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

/** What the ledger reads from one call besides the usage columns (ADR 0009). */
export type CallInput = {
  harness: Harness;
  method: string;
  path: string;
  status: number | null;
  requestHeaders: Headers;
  requestText: string | null;
  responseHeaders: Headers;
  responseText: string | null;
  /** The parsed data of each stream event; [] when the response was not a stream. */
  events: Json[];
  usage: Usage | null;
  quota: Record<string, string> | null;
};

export function readCallDetails(c: CallInput): CallDetails {
  const body = parseJson(c.requestText) ?? {};
  if (c.harness === "claude") {
    return { ...NO_DETAILS, ...claudeDetails.requestDetails(c.requestHeaders, body), ...claudeDetails.responseDetails(c.events, c.responseHeaders) };
  }
  const meta = codexDetails.turnMetadata(c.requestHeaders, body);
  return { ...NO_DETAILS, ...codexDetails.requestDetails(c.requestHeaders, body, meta), ...codexDetails.responseDetails(c.events) };
}

export function readCallRecords(c: CallInput): CallRecords {
  const body = parseJson(c.requestText) ?? {};
  const isModelCall = c.method === "POST";
  if (c.harness === "claude") {
    return {
      pieces: requestPieces("claude", c.requestText),
      toolUses: claudeDetails.toolUses(c.events),
      toolResults: claudeDetails.toolResults(body),
      quotaWindows: claudeQuotaWindows(c.quota),
      contextParts: isModelCall ? claudeContextParts(body, c.usage) : [],
      modelCatalog: [],
    };
  }
  // usage.attribution.items: exact tokens per input item (PLAN.md, field inventory 1).
  const completed = c.events.findLast((e) => e.type === "response.completed" || e.type === "response.incomplete");
  const attribution = completed?.response?.usage?.attribution?.items;
  const isCatalog = c.method === "GET" && /^\/models(\?|$)/.test(c.path) && c.status === 200;
  return {
    pieces: requestPieces("codex", c.requestText),
    toolUses: codexDetails.toolUses(c.events),
    toolResults: codexDetails.toolResults(body),
    quotaWindows: codexQuotaWindows(c.quota),
    contextParts: isModelCall ? codexContextParts(body, isObject(attribution) ? attribution : null) : [],
    modelCatalog: isCatalog ? codexDetails.modelCatalog(c.responseText) : [],
  };
}
