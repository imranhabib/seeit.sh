// Picks the provider for a harness. The rest of the gateway asks this file
// instead of checking the harness name itself.

import type { Harness, Usage } from "@seeit/core";
import { claudeCode } from "./anthropic/claude-code.ts";
import type { GatewayProvider } from "./model.ts";
import { codex } from "./openai/codex.ts";

const PROVIDERS = { claude: claudeCode, codex } satisfies Record<Harness, GatewayProvider>;

export function providerFor(harness: Harness): GatewayProvider {
  return PROVIDERS[harness];
}

/** Usage from a non-streaming JSON body (for example Claude's startup quota probe). */
export function usageFromJsonBody(harness: Harness, text: string): Usage | null {
  try {
    const usage = JSON.parse(text)?.usage;
    if (!usage || typeof usage !== "object") return null;
    return PROVIDERS[harness].usage(usage);
  } catch {
    return null;
  }
}

// Patterns from every provider, so a quota header is kept whichever response
// it arrives on.
const QUOTA_HEADERS = Object.values(PROVIDERS).flatMap((p) => p.quotaHeaders);

/** Plan-quota headers as a JSON string, or null when the response has none (PLAN.md, Phase 2). */
export function quotaHeaders(headers: Headers): string | null {
  const quota: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (QUOTA_HEADERS.some((pattern) => pattern.test(name))) quota[name] = value;
  });
  return Object.keys(quota).length ? JSON.stringify(quota) : null;
}
