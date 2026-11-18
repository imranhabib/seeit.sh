// Test helpers shared by the provider unit tests. Not part of @seeit/core's
// public interface (src/index.ts does not export it).

import { readFileSync } from "node:fs";
import { createSseParser } from "../../../src/sse.ts";
import { createInterpreter } from "../../../src/provider/index.ts";
import type { Provider, StreamSummary } from "../../../src/provider/model.ts";

/** A recorded SSE stream from packages/core/fixtures/. */
export const fixture = (name: string) => readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), "utf8");

/** Feed text in fixed-size chunks; each chunk "arrives" 10 ms after the previous one. */
export function run(provider: Provider, text: string, chunkSize = 37): StreamSummary {
  const parser = createSseParser();
  const interpreter = createInterpreter(provider);
  let atMs = 0;
  for (let i = 0; i < text.length; i += chunkSize) {
    atMs += 10;
    for (const e of parser.push(text.slice(i, i + chunkSize))) interpreter.onEvent(e, atMs);
  }
  for (const e of parser.flush()) interpreter.onEvent(e, atMs);
  return interpreter.summary();
}

/** The fixture text up to (not including) the first event of this type. */
export const before = (text: string, eventType: string) => text.slice(0, text.indexOf(`event: ${eventType}\n`));

// Spec-derived tests (ADR 0005, layer 1; PLAN.md follow-up step 2) are built
// from documented examples, one event every 10 ms, so a test can say exactly
// which event set a timing.

/** Turn objects into SSE text and run them; event i arrives at (i + 1) * 10 ms. */
export function runEvents(provider: Provider, events: object[]): StreamSummary {
  const parser = createSseParser();
  const interpreter = createInterpreter(provider);
  events.forEach((e, i) => {
    const type = (e as { type: string }).type;
    for (const ev of parser.push(`event: ${type}\ndata: ${JSON.stringify(e)}\n\n`)) interpreter.onEvent(ev, (i + 1) * 10);
  });
  for (const ev of parser.flush()) interpreter.onEvent(ev, events.length * 10);
  return interpreter.summary();
}
