// Claude Code, served by the Anthropic Messages API.

import { fromAnthropicUsage } from "@seeit/core";
import type { GatewayProvider } from "../model.ts";

export const claudeCode = {
  stream: "anthropic",
  usage: fromAnthropicUsage,
  quotaHeaders: [/^anthropic-ratelimit-unified-/],
} satisfies GatewayProvider;
