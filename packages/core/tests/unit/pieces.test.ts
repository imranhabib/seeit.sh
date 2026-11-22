import { describe, expect, it } from "vitest";
import { hashPiece, rebuildRequest, requestPieces } from "../../src/pieces.ts";

const bp = (ttl?: string) => ({ type: "ephemeral", ...(ttl ? { ttl } : {}) });

// Shaped like a Claude Code 2.1.326 request (PLAN.md, field inventory 2-3).
const claudeBody = {
  model: "claude-sonnet-5-5",
  max_tokens: 128000,
  system: [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.326.f48; cc_entrypoint=sdk-cli;" },
    { type: "text", text: "You are Claude Code.", cache_control: bp("1h") },
    { type: "text", text: "Main prompt", cache_control: bp("1h") },
  ],
  tools: [{ name: "Read", input_schema: { type: "object" } }],
  messages: [
    { role: "user", content: [{ type: "text", text: "<system-reminder>ctx</system-reminder>" }, { type: "text", text: "hi" }] },
    { role: "system", content: "Environment" },
    { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok", cache_control: bp("1h") }] },
  ],
  stream: true,
};

describe("requestPieces", () => {
  it("cuts a Claude request into tools, each system block, each message, and the other fields, in body order", () => {
    const pieces = requestPieces("claude", JSON.stringify(claudeBody));
    expect(pieces.map((p) => p.path)).toEqual(["system[0]", "system[1]", "system[2]", "tools", "messages[0]", "messages[1]", "messages[2]", "messages[3]", "fields"]);
    expect(pieces.find((p) => p.path === "fields")?.value).toEqual({ model: "claude-sonnet-5-5", max_tokens: 128000, stream: true });
  });

  it("cuts a Codex request into each input item and the other fields", () => {
    const body = { model: "gpt-6-luna", input: [{ type: "message", role: "user", id: "msg_1", content: [] }, { type: "reasoning", id: "rs_1" }], store: false };
    expect(requestPieces("codex", JSON.stringify(body)).map((p) => p.path)).toEqual(["input[0]", "input[1]", "fields"]);
  });

  it("keeps a body that is not a JSON object as one raw piece", () => {
    expect(requestPieces("claude", "not json")).toEqual([{ path: "raw", value: "not json", cacheControl: null }]);
  });

  it("returns no pieces when there is no body", () => {
    expect(requestPieces("codex", null)).toEqual([]);
  });

  it("rebuilds a request with the same content, cache markers included", () => {
    const text = JSON.stringify(claudeBody);
    expect(rebuildRequest(requestPieces("claude", text))).toEqual(claudeBody);
    const codex = { model: "m", input: [{ type: "message", content: [{ type: "input_text", text: "a" }] }], tools: [] };
    expect(rebuildRequest(requestPieces("codex", JSON.stringify(codex)))).toEqual(codex);
    expect(rebuildRequest(requestPieces("claude", "not json"))).toBe("not json");
  });

  // Claude Code moves the marker to the newest message on every call (ADR 0009).
  it("gives a message the same hash when only its cache marker moved", () => {
    const next = structuredClone(claudeBody);
    delete (next.messages[3]!.content as Record<string, unknown>[])[0]!.cache_control;
    next.messages.push({ role: "user", content: [{ type: "text", text: "more", cache_control: bp("1h") } as never] });
    const before = requestPieces("claude", JSON.stringify(claudeBody)).find((p) => p.path === "messages[3]")!;
    const after = requestPieces("claude", JSON.stringify(next)).find((p) => p.path === "messages[3]")!;
    expect(before.cacheControl).toEqual({ "content[0]": bp("1h") });
    expect(after.cacheControl).toBeNull();
    expect(hashPiece(before.value)).toBe(hashPiece(after.value));
  });

  it("records a system block's own marker under the empty path", () => {
    const piece = requestPieces("claude", JSON.stringify(claudeBody)).find((p) => p.path === "system[1]")!;
    expect(piece.cacheControl).toEqual({ "": bp("1h") });
    expect(piece.value).toEqual({ type: "text", text: "You are Claude Code." });
  });

  it("hashes different content differently", () => {
    expect(hashPiece({ a: 1 })).not.toBe(hashPiece({ a: 2 }));
    expect(hashPiece({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
