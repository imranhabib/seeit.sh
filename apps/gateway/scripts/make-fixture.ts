// Turn a recording's response stream into a redacted SSE fixture for tests.
// Usage: pnpm make-fixture <recording.json> <out.sse>
// Review the output by hand before committing: the repo is public.

import { readFile, writeFile } from "node:fs/promises";
import type { Recording } from "../src/recorder.ts";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: make-fixture <recording.json> <out.sse>");

const rec: Recording = JSON.parse(await readFile(input, "utf8"));
if (!rec.response.events) throw new Error("recording has no SSE events");

// Provider object IDs (msg_, resp_, req_, rs_, ...) are replaced with stable placeholders.
const ids = new Map<string, string>();
const redactIds = (text: string) =>
  text.replace(/\b(msg|resp|req|rs|fc|call|toolu)_[A-Za-z0-9]{8,}\b/g, (id, prefix) => {
    if (!ids.has(id)) ids.set(id, `${prefix}_fixture${ids.size + 1}`);
    return ids.get(id)!;
  });

const sse = rec.response.events
  .map((e) => {
    const data = structuredClone(e.data) as any;
    // Encrypted thinking blobs: opaque and large, not needed for tests.
    if (data?.delta?.type === "signature_delta") data.delta.signature = "fixture-signature";
    if (data?.content_block?.signature) data.content_block.signature = "fixture-signature";
    // Codex echoes the full request (system prompt, tools) in some events.
    if (data?.response) {
      for (const key of ["instructions", "tools", "metadata", "prompt_cache_key", "user", "safety_identifier"]) delete data.response[key];
    }
    const json = typeof data === "string" ? data : JSON.stringify(data);
    return `${e.event ? `event: ${e.event}\n` : ""}data: ${redactIds(json)}\n\n`;
  })
  .join("");

await writeFile(output, sse);
console.log(`wrote ${output}: ${rec.response.events.length} events, ${sse.length} chars`);
