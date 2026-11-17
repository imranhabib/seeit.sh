import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { openDatabase, type LedgerDatabase } from "./database.ts";
import { bodies, calls, type CallRow } from "./schema.ts";

const testUrl = process.env.SEEIT_TEST_DATABASE_URL;

// No shared tables are cleared: each suite creates and drops its own database.
// The configured test role needs CREATEDB; the gateway's SQLite file is unused.
describe.skipIf(!testUrl)("PostgreSQL ledger foundation", () => {
  const name = `seeit_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let database: LedgerDatabase;
  let connectionString: string;

  beforeAll(async () => {
    admin = new Pool({ connectionString: testUrl, connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(testUrl!);
    url.pathname = `/${name}`;
    connectionString = url.toString();
    database = await openDatabase(connectionString);
  });

  afterAll(async () => {
    // Nested so a failed step cannot skip dropping the test database.
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

  function call(id: string, overrides: Partial<CallRow> = {}): CallRow {
    return {
      id,
      startedAt: new Date("2026-11-17T12:34:56.789Z"),
      harness: "claude",
      kind: "turn",
      method: "POST",
      path: "/v1/messages",
      completion: "complete",
      tokensEstimated: false,
      ...overrides,
    };
  }

  it("round-trips every metadata field without narrowing counters or timings", async () => {
    const row: typeof calls.$inferSelect = {
      ...call("metadata"),
      harnessVersion: "claude-cli/test", sessionId: "session-1", turnId: "turn-1",
      httpStatus: 200, errorType: null, model: "test-model",
      inputTokens: 5_000_000_000, cacheReadTokens: 100, cacheWriteTokens: 30,
      cacheWrite5mTokens: 10, cacheWrite1hTokens: 20, outputTokens: 50,
      reasoningTokens: 5, codexRolloutBudgetUnits: 0.123456789,
      serverToolUse: { web_search_requests: 1 },
      timeToResponseHeadersMs: 12.123456789, timeToFirstChunkMs: 13.123456789,
      timeToFirstTokenMs: 14.123456789, timeToStreamEndMs: 100.123456789,
      toolsCount: 11, toolsChars: 5_000_000_000, instructionsChars: 400,
      quota: { "test-limit": "0.25" }, flags: ["test-flag"],
      unknownEvents: { "test.event": 2 }, unknownUsageFields: ["test_field"],
    };
    await database.db.insert(calls).values(row);
    const [stored] = await database.db.select().from(calls).where(eq(calls.id, row.id));
    expect(stored).toEqual(row);
  });

  it("keeps unknown values distinct from reported zero and checked-empty JSON", async () => {
    await database.db.insert(calls).values([
      call("unknown", { harness: "codex", path: "/responses" }),
      call("zero", { inputTokens: 0, outputTokens: 0, flags: [], unknownEvents: {}, unknownUsageFields: [] }),
    ]);
    const [unknown] = await database.db.select().from(calls).where(eq(calls.id, "unknown"));
    expect(unknown).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      sessionId: null,
      quota: null,
      flags: null,
      unknownEvents: null,
      unknownUsageFields: null,
    });
    const [zero] = await database.db.select().from(calls).where(eq(calls.id, "zero"));
    expect(zero).toMatchObject({ inputTokens: 0, outputTokens: 0, flags: [], unknownEvents: {}, unknownUsageFields: [] });
  });

  it("stores compressed Unicode bodies and enforces their call relationship", async () => {
    const request = "synthetic request: 你好 🌍";
    const response = "synthetic response: café";
    const body = {
      callId: "with-body",
      createdAt: new Date("2026-11-17T12:34:56.789Z"),
      requestGz: gzipSync(request),
      responseGz: gzipSync(response),
    };
    await expect(database.db.insert(bodies).values(body)).rejects.toThrow();
    await database.db.insert(calls).values(call(body.callId));
    await database.db.insert(bodies).values(body);
    const [stored] = await database.db.select().from(bodies).where(eq(bodies.callId, body.callId));
    expect(stored).toEqual(body);
    expect(gunzipSync(stored!.requestGz!).toString()).toBe(request);
    expect(gunzipSync(stored!.responseGz!).toString()).toBe(response);
    await expect(database.db.insert(calls).values(call(body.callId))).rejects.toThrow();
    await database.db.delete(calls).where(eq(calls.id, body.callId));
    expect(await database.db.select().from(bodies).where(eq(bodies.callId, body.callId))).toEqual([]);
  });

  it("preserves committed data across connections and reapplies migrations safely", async () => {
    await database.db.insert(calls).values(call("persistent"));
    // A second open runs the migrations again on a database that has them.
    const reopened = await openDatabase(connectionString);
    try {
      const rows = await reopened.db.select({ id: calls.id }).from(calls).where(eq(calls.id, "persistent"));
      expect(rows).toEqual([{ id: "persistent" }]);
    } finally {
      await reopened.close();
    }
  });

  it("reports ready without caching when the database answers", async () => {
    const response = await createApp(database).request("/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ready" });
  });

  it("returns unavailable without exception details when the database connection is closed", async () => {
    const disconnected = await openDatabase(connectionString);
    await disconnected.close();
    const response = await createApp(disconnected).request("/health");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });

  it("closes database connections when HTTP startup fails", async () => {
    // Occupy a port so the ledger's listen fails after the database is open.
    // If the pool stayed open the child would idle until the timeout kills it.
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const { port } = blocker.address() as { port: number };
    try {
      await expect(
        promisify(execFile)(process.execPath, ["--import", "tsx", "src/index.ts"], {
          cwd: fileURLToPath(new URL("../..", import.meta.url)),
          env: { ...process.env, SEEIT_LEDGER_DATABASE_URL: connectionString, SEEIT_LEDGER_PORT: String(port) },
          timeout: 4000,
        }),
      ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("[ledger] HTTP server failed") });
    } finally {
      blocker.close();
    }
  }, 10000);
});
