// Summarize Phase 0 recordings to answer the spike questions:
// session IDs, where usage appears, quota headers, and the paths each harness calls.
// Usage: pnpm summarize [recordDir]

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { Recording } from "../src/recorder.ts";

// Header names whose values are worth showing (not just their names).
const INTERESTING = /session|conversation|request-id|user-agent|version|beta|originator|ratelimit|limit|usage|quota|percent|reset/i;

const dir = process.argv[2] ?? loadConfig().recordDir;
const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".json"));
const recordings: Recording[] = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8"))));

const byHarness = Map.groupBy(recordings, (r) => r.harness);
console.log(`${recordings.length} recordings in ${dir}\n`);

for (const [harness, recs] of byHarness) {
  console.log(`=== ${harness} (${recs.length} calls) ===`);

  section("Calls", count(recs.map((r) => `${r.request.method} ${r.request.path.split("?")[0]} -> ${r.response.status}`)));
  section("Request headers", headerSummary(recs.map((r) => r.request.headers)));
  section("Response headers", headerSummary(recs.map((r) => r.response.headers)));

  const bodies = recs.map((r) => r.request.body).filter(isObject);
  section("Request body keys", count(bodies.flatMap((b) => Object.keys(b))));
  const metadata = bodies.map((b) => b.metadata).filter((m) => m !== undefined);
  if (metadata.length) section("Request body 'metadata' (samples)", unique(metadata.map((m) => JSON.stringify(m))).slice(0, 3));

  section("SSE event types", count(recs.flatMap((r) => r.response.events ?? []).map((e) => e.event ?? "(none)")));

  const usages = recs.flatMap((r) => [...(r.response.events ?? []).map((e) => e.data), r.response.body]).flatMap(findUsage);
  section("'usage' objects found (last 2)", usages.slice(-2).map((u) => JSON.stringify(u)));

  const ttft = recs.map((r) => r.timings.timeToFirstChunkMs).filter((n): n is number => typeof n === "number"); // recordings made before the rename have no value
  if (ttft.length) section("First chunk (ms)", [`min ${min(ttft)}, max ${Math.round(Math.max(...ttft))}`]);
  console.log();
}

function headerSummary(all: Record<string, string>[]): string[] {
  const values = new Map<string, Set<string>>();
  for (const headers of all) {
    for (const [name, value] of Object.entries(headers)) {
      if (!values.has(name)) values.set(name, new Set());
      values.get(name)!.add(value);
    }
  }
  return [...values].sort().map(([name, vals]) =>
    INTERESTING.test(name) ? `${name}: ${[...vals].slice(0, 3).join(" | ")}${vals.size > 3 ? ` (+${vals.size - 3} more)` : ""}` : name,
  );
}

/** Find every object stored under a "usage" key, at any depth. */
function findUsage(value: unknown): unknown[] {
  if (!isObject(value)) return Array.isArray(value) ? value.flatMap(findUsage) : [];
  return Object.entries(value).flatMap(([k, v]) => (k === "usage" && isObject(v) ? [v] : findUsage(v)));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function count(items: string[]): string[] {
  const counts = Map.groupBy(items, (i) => i);
  return [...counts].map(([item, list]) => `${list.length}× ${item}`);
}
function unique(items: string[]): string[] {
  return [...new Set(items)];
}
function min(ns: number[]): number {
  return Math.round(Math.min(...ns));
}
function section(title: string, lines: string[]) {
  console.log(`-- ${title}`);
  for (const line of lines) console.log(`   ${line}`);
}
