import { describe, expect, it } from "vitest";
import { interpretResponse } from "../../src/response.ts";
import { fixture, run } from "./provider/helpers.ts";

/** Split text into pieces of `size` characters, one every 10 ms (like helpers.run). */
const pieces = (text: string, size = 37): [number, number][] =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, i) => [Math.min(size, text.length - i * size), (i + 1) * 10]);

describe("interpretResponse", () => {
  // Replaying a capture must give what live parsing gave (the gateway parsed live before).
  it.each([
    ["claude", "anthropic", "anthropic-claude-2.1.322.sse"],
    ["codex", "openai-responses", "openai-codex-0.153.4.sse"],
    ["codex", "openai-responses", "openai-codex-desktop-0.169.0.sse"],
  ] as const)("replays a %s capture with the timings of live parsing (%s, %s)", (harness, provider, name) => {
    const text = fixture(name);
    const replayed = interpretResponse(harness, { text, pieces: pieces(text), contentType: "text/event-stream", timeToStreamEndMs: 9999 });
    expect(replayed.isStream).toBe(true);
    expect(replayed.summary).toEqual(run(provider, text));
  });

  // The ChatGPT backend sends SSE without a content-type header.
  it("recognizes a stream from its first text when there is no content-type", () => {
    const text = fixture("openai-codex-0.153.4.sse");
    const all = pieces(text);
    const replayed = interpretResponse("codex", { text: "\n" + text, pieces: [[1, 5], ...all], contentType: null, timeToStreamEndMs: 9999 });
    expect(replayed.isStream).toBe(true);
    expect(replayed.summary.final).toBe(true);
  });

  it("does not parse a JSON body as a stream", () => {
    const text = JSON.stringify({ type: "message", usage: { input_tokens: 1, output_tokens: 1 } });
    const replayed = interpretResponse("claude", { text, pieces: [[text.length, 20]], contentType: "application/json", timeToStreamEndMs: 20 });
    expect(replayed.isStream).toBe(false);
    expect(replayed.summary.usage).toBeNull();
  });
});
