// Ingestion against a real PostgreSQL database (run with pnpm --filter
// @seeit/ledger test:db). Each suite creates and drops its own database.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { rebuildRequest, type RecordedCall } from "@seeit/core";
import { and, asc, eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { openDatabase, type LedgerDatabase } from "./db/database.ts";
import { bodies, bodyPieces, callPieces, calls, contextParts, modelCatalog, quotaWindows, sessions, toolUses, turns, users } from "./db/schema.ts";

const testUrl = process.env.SEEIT_TEST_DATABASE_URL;
const fixture = (name: string) => readFileSync(new URL(`../../../packages/core/fixtures/${name}`, import.meta.url), "utf8");
const pieces = (text: string): [number, number][] => Array.from({ length: Math.ceil(text.length / 64) }, (_, i) => [Math.min(64, text.length - i * 64), 100 + i]);

const bp = { type: "ephemeral", ttl: "1h" };
const claudeRequest = {
  model: "claude-sonnet-5-5",
  system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.322.abc; cc_entrypoint=cli;" }, { type: "text", text: "You are Claude Code.", cache_control: bp }],
  tools: [{ name: "Read" }],
  messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: bp }] }],
};

function claudeCall(id: string, version = "claude-cli/2.1.322", request: object = claudeRequest): RecordedCall {
  const body = fixture("anthropic-claude-2.1.322.sse");
  return {
    id,
    userId: "local",
    seq: 1,
    startedAt: "2026-11-18T00:00:00.000Z",
    harness: "claude",
    method: "POST",
    path: "/v1/messages?beta=true",
    turnId: "t1",
    request: {
      headers: { "user-agent": `${version} (external, cli)`, "x-claude-code-session-id": "s1", authorization: "[redacted, 20 chars]" },
      body: JSON.stringify(request),
    },
    response: {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "request-id": "req_011",
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

/** The request of a stored call, rebuilt from its pieces. */
async function rebuildFrom(database: LedgerDatabase, id: string) {
  const rows = await database.db
    .select({ path: callPieces.path, cacheControl: callPieces.cacheControl, gz: bodyPieces.gz })
    .from(callPieces)
    .innerJoin(calls, eq(calls.id, callPieces.callId))
    .innerJoin(
      bodyPieces,
      and(eq(bodyPieces.userId, calls.userId), eq(bodyPieces.harness, calls.harness), eq(bodyPieces.scope, sql`coalesce(${calls.sessionId}, ${calls.id})`), eq(bodyPieces.hash, callPieces.hash)),
    )
    .where(eq(callPieces.callId, id))
    .orderBy(asc(callPieces.ordinal));
  return rebuildRequest(rows.map((r) => ({ path: r.path, cacheControl: r.cacheControl, value: JSON.parse(gunzipSync(r.gz).toString()) })));
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
  const rebuild = (id: string) => rebuildFrom(database, id);

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
    // The request is stored as pieces now (ADR 0009); it rebuilds with the same content.
    expect(stored!.requestGz).toBeNull();
    expect(await rebuild("claude-1")).toEqual(JSON.parse(call.request.body!));
  });

  it("stores the user, session, turn, and detail columns of a call", async () => {
    await post(claudeCall("detail-1"));
    const [row] = await database.db.select().from(calls).where(eq(calls.id, "detail-1"));
    expect(row).toMatchObject({ userId: "local", seq: 1, providerRequestId: "req_011", harnessBuild: "2.1.322.abc", entrypoint: "cli", cacheTtl: "1h" });
    expect(await database.db.select().from(users)).toContainEqual(expect.objectContaining({ id: "local" }));
    const [session] = await database.db.select().from(sessions).where(and(eq(sessions.userId, "local"), eq(sessions.harness, "claude"), eq(sessions.id, "s1")));
    expect(session).toMatchObject({ harnessVersion: "claude-cli/2.1.322" });
    const [turn] = await database.db.select().from(turns).where(eq(turns.id, "t1"));
    expect(turn).toMatchObject({ userId: "local", sessionId: "s1", source: "inferred" });
  });

  it("moves a turn's start to an earlier call that arrives late", async () => {
    const late = { ...claudeCall("turn-late"), turnId: "t-late", startedAt: "2026-11-18T00:00:05.000Z" };
    const early = { ...claudeCall("turn-early"), turnId: "t-late", startedAt: "2026-11-18T00:00:01.000Z" };
    await post(late);
    await post(early);
    const [turn] = await database.db.select().from(turns).where(eq(turns.id, "t-late"));
    expect(turn).toMatchObject({ startedByCallId: "turn-early", startedAt: new Date("2026-11-18T00:00:01.000Z") });
  });

  it("keeps two users with the same session ID apart", async () => {
    await post({ ...claudeCall("user-a"), userId: "alice", turnId: "t-alice" });
    await post({ ...claudeCall("user-b"), userId: "bob", turnId: "t-bob" });
    const rows = await database.db.select().from(sessions).where(eq(sessions.id, "s1"));
    expect(rows.map((r) => r.userId).sort()).toEqual(["alice", "bob", "local"]);
    const pieceUsers = await database.db.selectDistinct({ userId: bodyPieces.userId }).from(bodyPieces).where(eq(bodyPieces.scope, "s1"));
    expect(pieceUsers.map((r) => r.userId).sort()).toEqual(["alice", "bob", "local"]);
    expect(await rebuild("user-b")).toEqual(claudeRequest);
  });

  // Claude Code moves cache_control to the newest message on every call (ADR 0009).
  it("stores a message once when only its cache marker moved", async () => {
    const next = {
      ...claudeRequest,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
        { role: "user", content: [{ type: "text", text: "more", cache_control: bp }] },
      ],
    };
    const piecesIn = async (scope: string) => (await database.db.select({ hash: bodyPieces.hash }).from(bodyPieces).where(eq(bodyPieces.scope, scope))).length;
    await post({ ...claudeCall("marker-1", undefined, claudeRequest), request: { ...claudeCall("x").request, headers: { ...claudeCall("x").request.headers, "x-claude-code-session-id": "s-marker" } } });
    const before = await piecesIn("s-marker");
    await post({ ...claudeCall("marker-2", undefined, next), request: { headers: { ...claudeCall("x").request.headers, "x-claude-code-session-id": "s-marker" }, body: JSON.stringify(next) } });
    // Only the two new messages are new pieces.
    expect((await piecesIn("s-marker")) - before).toBe(2);
    expect(await rebuild("marker-2")).toEqual(next);
  });

  it("stores tool uses as labels and fills the result size from the next request", async () => {
    const sse = [
      { type: "message_start", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Skill" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"skill":"make-notes","args":"private"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ]
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join("");
    const asking = claudeCall("tools-1");
    await post({ ...asking, response: { ...asking.response, body: sse, pieces: pieces(sse) } });
    const answer = { ...claudeRequest, messages: [...claudeRequest.messages, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "12345" }] }] };
    await post(claudeCall("tools-2", undefined, answer));
    const [use] = await database.db.select().from(toolUses).where(eq(toolUses.callId, "tools-1"));
    expect(use).toEqual({ callId: "tools-1", toolUseId: "toolu_1", kind: "skill", name: "Skill", namespace: null, target: "make-notes", plugin: null, durationMs: null, resultChars: 5 });
  });

  it("stores quota windows and context parts", async () => {
    await post(claudeCall("parts-1"));
    const windows = await database.db.select().from(quotaWindows).where(eq(quotaWindows.callId, "parts-1")).orderBy(asc(quotaWindows.window));
    expect(windows.map((w) => [w.window, w.usedPercent, w.resetsAt?.toISOString() ?? null])).toEqual([["5h", 85, "2026-11-18T03:40:00.000Z"], ["7d", 11, null]]);
    const parts = await database.db.select().from(contextParts).where(eq(contextParts.callId, "parts-1")).orderBy(asc(contextParts.ordinal));
    expect(parts.map((p) => [p.section, p.category, p.label])).toEqual([
      ["tools", "tool_definitions", "tool:Read"],
      ["system", "system_prompt", "billing"],
      ["system", "system_prompt", null],
      ["messages", "user_prompt", null],
    ]);
    expect(parts.every((p) => p.analysisVersion === 1)).toBe(true);
  });

  it("keeps the newest Codex model catalog per user and harness version", async () => {
    const catalog = (id: string, at: string, window: number): RecordedCall => {
      const body = JSON.stringify({ models: [{ slug: "gpt-6-luna", context_window: window }] });
      return {
        ...claudeCall(id),
        harness: "codex",
        method: "GET",
        path: "/models?client_version=0.169.1",
        turnId: null,
        startedAt: at,
        request: { headers: { "user-agent": "iris/0.169.1" }, body: null },
        response: { status: 200, headers: { "content-type": "application/json" }, body, pieces: pieces(body) },
      };
    };
    await post(catalog("models-new", "2026-11-18T02:00:00.000Z", 500000));
    await post(catalog("models-old", "2026-11-18T01:00:00.000Z", 272000));
    const rows = await database.db.select().from(modelCatalog);
    expect(rows).toEqual([expect.objectContaining({ userId: "local", harness: "codex", harnessVersion: "0.169.1", model: "gpt-6-luna", contextWindow: 500000, callId: "models-new" })]);
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
    expect(await database.db.select().from(callPieces).where(eq(callPieces.callId, "retried"))).toHaveLength(5);
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
