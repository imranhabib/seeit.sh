import { describe, expect, it } from "vitest";
import { decideCompletion } from "../../src/completion.ts";

describe("decideCompletion", () => {
  const base = { status: 200, isStream: true, final: false, errorType: null, clientAborted: false, readFailed: false, gatewayFailed: false, connectivityCheck: false };

  it("is complete when the final event arrived, even if the connection then closed (Codex)", () => {
    expect(decideCompletion({ ...base, final: true, clientAborted: true, readFailed: true })).toBe("complete");
  });
  it("is upstream_error for an error event or an HTTP error", () => {
    expect(decideCompletion({ ...base, errorType: "overloaded_error" })).toBe("upstream_error");
    expect(decideCompletion({ ...base, status: 429, isStream: false })).toBe("upstream_error");
  });
  it("is client_aborted when the harness left before the final event", () => {
    expect(decideCompletion({ ...base, clientAborted: true, readFailed: true })).toBe("client_aborted");
  });
  it("is upstream_dropped when upstream failed or the stream ended early", () => {
    expect(decideCompletion({ ...base, readFailed: true })).toBe("upstream_dropped");
    expect(decideCompletion({ ...base })).toBe("upstream_dropped");
    expect(decideCompletion({ ...base, status: null })).toBe("upstream_dropped");
  });
  it("is complete for a non-streaming body read to the end", () => {
    expect(decideCompletion({ ...base, isStream: false })).toBe("complete");
  });
  // PLAN.md, live-run finding 1: Claude Code 2.1.133's HEAD /claude gets a 404. Any answer means the check worked.
  it("is complete for a connectivity check that got any answer, even a 404", () => {
    expect(decideCompletion({ ...base, connectivityCheck: true, isStream: false, status: 404 })).toBe("complete");
    expect(decideCompletion({ ...base, connectivityCheck: true, isStream: false, status: null })).toBe("upstream_dropped");
  });
  it("is gateway_error when the gateway itself failed", () => {
    expect(decideCompletion({ ...base, final: true, gatewayFailed: true })).toBe("gateway_error");
  });
});
