import { describe, expect, it } from "vitest";
import { quotaHeaders } from "../../../src/provider/index.ts";

// Codex header names come from codex-rs/codex-api/src/rate_limits.rs at
// openai/codex@9537934ed6d5a6658fc77032b3290650765466a1.
describe("quotaHeaders", () => {
  it("keeps Anthropic's unified rate-limit headers", () => {
    const h = new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.25", "request-id": "req_1" });
    expect(JSON.parse(quotaHeaders(h)!)).toEqual({ "anthropic-ratelimit-unified-5h-utilization": "0.25" });
  });

  it("keeps the default and per-limit Codex windows, credits, and status headers", () => {
    const codex = {
      "x-codex-primary-used-percent": "12.5",
      "x-codex-secondary-reset-at": "1704069000",
      // Sent by the server (seen live 2026-11-16), not read by the Codex client.
      "x-codex-primary-reset-after-seconds": "3600",
      "x-codex-primary-over-secondary-limit-percent": "0",
      // Per-limit family: x-<limit_id>-primary-* (limit_id "codex_other").
      "x-codex-other-primary-used-percent": "80",
      "x-codex-other-secondary-window-minutes": "1440",
      "x-codex-other-limit-name": "Other models",
      "x-codex-credits-has-credits": "true",
      "x-codex-credits-unlimited": "false",
      "x-codex-credits-balance": "12.00",
      "x-codex-plan-type": "pro",
      "x-codex-active-limit": "codex",
      "x-codex-rate-limit-reached-type": "primary",
      "x-codex-promo-message": "Try the new model",
    };
    expect(JSON.parse(quotaHeaders(new Headers({ ...codex, "x-oai-request-id": "r1", "x-codex-turn-state": "s", "x-models-etag": "e", "content-type": "text/event-stream" }))!)).toEqual(codex);
  });

  it("is null when the response has no quota headers", () => {
    expect(quotaHeaders(new Headers({ "content-type": "application/json" }))).toBeNull();
  });
});
