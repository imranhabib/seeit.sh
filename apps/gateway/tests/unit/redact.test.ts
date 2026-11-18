import { describe, expect, it } from "vitest";
import { redactHeaders } from "../../src/redact.ts";

describe("redactHeaders", () => {
  it("redacts credentials and account identifiers, keeping only their length", () => {
    const out = redactHeaders(
      new Headers({
        authorization: "Bearer secret-token",
        "x-api-key": "sk-test-123",
        cookie: "session=abc",
        "set-cookie": "cf=xyz",
        "chatgpt-account-id": "acct-1",
        // Seen live on every Anthropic response (Iris run, 2026-11-17).
        "anthropic-organization-id": "org-uuid",
        // Opaque state the ChatGPT backend issues and Codex sends back.
        "x-codex-turn-state": "gAAAAABopaque",
      }),
    );
    for (const [name, value] of Object.entries(out)) expect(value, name).toMatch(/^\[redacted, \d+ chars\]$/);
    expect(JSON.stringify(out)).not.toMatch(/secret-token|sk-test|abc|xyz|acct-1|org-uuid|gAAAA/);
  });

  it("keeps headers the gateway and its tools need", () => {
    const headers = {
      "user-agent": "claude-cli/2.1.326 (external, cli)",
      "x-claude-code-session-id": "s1",
      "x-claude-code-agent-id": "agent-1",
      "session-id": "c1",
      "anthropic-ratelimit-unified-5h-utilization": "0.25",
      "content-type": "text/event-stream",
    };
    expect(redactHeaders(new Headers(headers))).toEqual(headers);
  });
});
