// Ingestion against a real PostgreSQL database (run with pnpm --filter
// @seeit/ledger test:db). Each suite creates and drops its own database.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { RecordedCall } from "@seeit/core";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { openDatabase, type LedgerDatabase } from "./db/database.ts";
import { bodies, calls } from "./db/schema.ts";

const testUrl = process.env.SEEIT_TEST_DATABASE_URL;
const fixture = (name: string) => readFileSync(new URL(`../../../packages/core/fixtures/${name}`, import.meta.url), "utf8");
const pieces = (text: string): [number, number][] => Array.from({ length: Math.ceil(text.length / 64) }, (_, i) => [Math.min(64, text.length - i * 64), 100 + i]);

function claudeCall(id: string, version = "claude-cli/2.1.322"): RecordedCall {
  const body = fixture("anthropic-claude-2.1.322.sse");
  return {
    id,
    startedAt: "2026-11-18T00:00:00.000Z",
    harness: "claude",
    method: "POST",
    path: "/v1/messages?beta=true",
    turnId: "t1",
    request: {
      headers: { "user-agent": `${version} (external, cli)`, "x-claude-code-session-id": "s1", authorization: "[redacted, 20 chars]" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", tools: [{ name: "Read" }], messages: [{ role: "user", content: "hi" }] }),
    },
    response: {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "anthropic-ratelimit-unified-5h-utilization": "0.85",
        "anthropic-ratelimit-unified-5h-reset": "1794973200",
        "anthropic-ratelimit-unified-7d-utilization": "0.11",
      },
      body,
      pieces: pieces(body),
    },
    timeToResponseHeadersMs: 90,
    timeToFirstChunkMs: 100,
    timeToStreamEndMs: 900,
    clientAborted: false,
    readFailed: false,
  };
}

function codexCall(id: string): RecordedCall {
  const body = fixture("openai-codex-0.153.4.sse");
  return {
    ...claudeCall(id),
    harness: "codex",
    path: "/responses",
    request: {
      headers: { "user-agent": "codex_exec/0.153.4", "x-codex-turn-metadata": JSON.stringify({ session_id: "s2", turn_id: "ct1", request_kind: "turn" }) },
      body: JSON.stringify({ model: "gpt-6-luna", input: [] }),
    },
    response: {
      status: 200,
      // No content-type: the ChatGPT backend sends none.
      headers: { "x-codex-primary-used-percent": "44", "x-codex-primary-window-minutes": "10080", "x-codex-primary-reset-at": "1795119697", "x-codex-plan-type": "plus" },
      body,
      pieces: pieces(body),
    },
  };
}

describe.skipIf(!testUrl)("PostgreSQL recording ingestion", () => {
  const name = `seeit_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let database: LedgerDatabase;
  let post: (call: RecordedCall) => Promise<Response>;

  beforeAll(async () => {
    admin = new Pool({ connectionString: testUrl, connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(testUrl!);
    url.pathname = `/${name}`;
    database = await openDatabase(url.toString());
    const app = createApp(database, { writeToken: "secret-token" });
    post = async (call) =>
      app.request("/ingest/calls", { method: "POST", headers: { authorization: "Bearer secret-token", "content-type": "application/json" }, body: JSON.stringify(call) });
  });

  afterAll(async () => {
    try {
      await database?.close();
    } finally {
      try {
        await admin?.query(`DROP DATABASE IF EXISTS "${name}"`);
      } finally {
        await admin?.end();
      }
    }
  });

  it("analyzes and stores a Claude Code call with its bodies and quota, then acknowledges", async () => {
    const call = claudeCall("claude-1");
    const response = await post(call);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ status: "stored" });

    const [row] = await database.db.select().from(calls).where(eq(calls.id, "claude-1"));
    expect(row).toMatchObject({
      harness: "claude",
      harnessVersion: "claude-cli/2.1.322",
      sessionId: "s1",
      turnId: "t1",
      kind: "turn",
      completion: "complete",
      tokensEstimated: false,
      startedAt: new Date("2026-11-18T00:00:00.000Z"),
      flags: [],
      quota: { "anthropic-ratelimit-unified-5h-utilization": "0.85", "anthropic-ratelimit-unified-5h-reset": "1794973200", "anthropic-ratelimit-unified-7d-utilization": "0.11" },
    });
    expect(row!.outputTokens).not.toBeNull();
    expect(row!.timeToFirstTokenMs).toBeGreaterThanOrEqual(100);

    const [stored] = await database.db.select().from(bodies).where(eq(bodies.callId, "claude-1"));
    expect(gunzipSync(stored!.responseGz!).toString()).toBe(call.response.body);
    expect(gunzipSync(stored!.requestGz!).toString()).toBe(call.request.body);
  });

  it("stores a Codex call and its quota windows", async () => {
    expect((await post(codexCall("codex-1"))).status).toBe(201);
    const [row] = await database.db.select().from(calls).where(eq(calls.id, "codex-1"));
    expect(row).toMatchObject({
      harness: "codex",
      sessionId: "s2",
      turnId: "t1",
      completion: "complete",
      quota: { "x-codex-primary-used-percent": "44", "x-codex-primary-window-minutes": "10080", "x-codex-primary-reset-at": "1795119697", "x-codex-plan-type": "plus" },
    });
  });

  it("acknowledges a retried call as a duplicate and stores it once", async () => {
    const call = claudeCall("retried");
    expect((await post(call)).status).toBe(201);
    const again = await post(call);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "duplicate" });
    expect(await database.db.select().from(calls).where(eq(calls.id, "retried"))).toHaveLength(1);
    expect(await database.db.select().from(bodies).where(eq(bodies.callId, "retried"))).toHaveLength(1);
  });

  it("flags only the first call from a harness version with no fixture", async () => {
    await post(claudeCall("new-1", "claude-cli/9.9.9"));
    await post(claudeCall("new-2", "claude-cli/9.9.9"));
    const flagsOf = async (id: string) => (await database.db.select({ flags: calls.flags }).from(calls).where(eq(calls.id, id)))[0]!.flags;
    expect(await flagsOf("new-1")).toEqual(["untested_harness_version"]);
    expect(await flagsOf("new-2")).toEqual([]);
  });

  // Seen live (2026-11-18): Codex sends two GET /models calls a few ms apart.
  it("flags only one of several calls from a new version that arrive at the same moment", async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => post(claudeCall(`same-${i}`, "claude-cli/8.8.8"))));
    const rows = await database.db.select({ flags: calls.flags }).from(calls).where(eq(calls.harnessVersion, "claude-cli/8.8.8"));
    expect(rows.filter((r) => r.flags?.includes("untested_harness_version"))).toHaveLength(1);
  });
});
