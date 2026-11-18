// The shape of what the gateway needs to know about one provider. Parsing
// itself lives in @seeit/core; a provider here only names which parts of
// core to use and which provider-specific headers to keep.

import type { Provider, Usage } from "@seeit/core";

export type GatewayProvider = {
  /** Which @seeit/core stream interpreter reads the response. */
  stream: Provider;
  /**
   * Turns the provider's own usage object into the shared Usage shape.
   * `never` lets each provider keep its own parameter type.
   */
  usage: (raw: never) => Usage;
  /** Response headers that report plan quota (PLAN.md, Phase 2). */
  quotaHeaders: RegExp[];
};
