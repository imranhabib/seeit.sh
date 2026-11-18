import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";
import { openLedger, type Ledger } from "./db/ledger.ts";
import { calls, type CallRow } from "./db/schema.ts";
import type { CallList } from "./ledger-api.ts";

let ledger: Ledger;
let app: ReturnType<typeof createApp>;

function call(id: string, overrides: Partial<CallRow> = {}): CallRow {
  return {
    id,
    startedAt: "2026-11-16T12:00:00.000Z",
    harness: "claude",
    harnessVersion: "claude-cli/test",
    sessionId: "shared-session",
    turnId: "turn-1",
    kind: "turn",
    method: "POST",
    path: "/v1/messages?private=value",
    completion: "complete",
    httpStatus: 200,
    model: "test-model",
    inputTokens: 10,
    cacheReadTokens: 20,
    cacheWriteTokens: 30,
    outputTokens: 5,
    reasoningTokens: 2,
    tokensEstimated: false,
    quota: JSON.stringify({ "test-quota-header": "private-value" }),
    ...overrides,
  };
}

beforeEach(() => {
  ledger = openLedger(":memory:");
  app = createApp({
    host: "127.0.0.1", port: 0, recordDir: "unused", dbPath: ":memory:",
    upstreams: { claude: "http://127.0.0.1:1", codex: "http://127.0.0.1:1" },
  }, ledger);
});

afterEach(() => {
  vi.restoreAllMocks();
  ledger.close();
});

describe("ledger API", () => {
  it("returns an empty list rather than inventing usage", async () => {
    const res = await app.request("/api/calls");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ calls: [], nextOffset: null });
  });

  it("supports HEAD with the GET status and headers but no body", async () => {
    const res = await app.request("/api/calls", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
  });

  it("paginates newest first, with a stable ID order for equal timestamps", async () => {
    ledger.db.insert(calls).values([
      call("older", { startedAt: "2026-11-15T12:00:00.000Z" }), call("a"), call("b"),
    ]).run();
    const page: CallList = await (await app.request("/api/calls?limit=2")).json();
    expect(page.calls.map((row) => row.id)).toEqual(["b", "a"]);
    expect(page.nextOffset).toBe(2);
    const last: CallList = await (await app.request(`/api/calls?limit=2&offset=${page.nextOffset}`)).json();
    expect(last.calls.map((row) => row.id)).toEqual(["older"]);
    expect(last.nextOffset).toBeNull();
    expect(await (await app.request("/api/calls?offset=100")).json()).toEqual({ calls: [], nextOffset: null });
  });

  it("combines harness, session, and kind filters without merging harnesses", async () => {
    ledger.db.insert(calls).values([
      call("match"), call("other-harness", { harness: "codex" }),
      call("other-session", { sessionId: "different" }), call("background", { kind: "background", turnId: null }),
    ]).run();
    const page: CallList = await (await app.request("/api/calls?harness=claude&session=shared-session&kind=turn")).json();
    expect(page.calls.map((row) => row.id)).toEqual(["match"]);
    const none: CallList = await (await app.request("/api/calls?session=missing")).json();
    expect(none.calls).toEqual([]);
    const background: CallList = await (await app.request("/api/calls?kind=background")).json();
    expect(background.calls.map((row) => row.id)).toEqual(["background"]);
  });

  it("keeps unknown usage, zero usage, and estimated usage distinct", async () => {
    ledger.db.insert(calls).values([
      call("unknown", { inputTokens: null, outputTokens: null, sessionId: null, turnId: null, kind: "connectivity" }),
      call("zero", { inputTokens: 0, outputTokens: 0 }),
      call("estimate", { tokensEstimated: true, completion: "client_aborted" }),
    ]).run();
    const page: CallList = await (await app.request("/api/calls")).json();
    expect(page.calls.find((row) => row.id === "unknown")).toMatchObject({ inputTokens: null, outputTokens: null, sessionId: null });
    expect(page.calls.find((row) => row.id === "zero")).toMatchObject({ inputTokens: 0, outputTokens: 0, tokensEstimated: false });
    expect(page.calls.find((row) => row.id === "estimate")).toMatchObject({ tokensEstimated: true, completion: "client_aborted" });
  });

  it("returns the default 50 rows and enforces the maximum of 100", async () => {
    ledger.db.insert(calls).values(Array.from({ length: 101 }, (_, n) => call(`call-${n}`))).run();
    const page: CallList = await (await app.request("/api/calls")).json();
    expect(page.calls).toHaveLength(50);
    expect(page.nextOffset).toBe(50);
    const max: CallList = await (await app.request("/api/calls?limit=100")).json();
    expect(max.calls).toHaveLength(100);
    expect(max.nextOffset).toBe(100);
  });

  it.each([
    "limit=0", "limit=101", "limit=1.5", "limit=", "limit=abc", "limit=1e2",
    "offset=-1", "offset=0.5", "offset=9007199254740992", "offset=",
    "harness=other", "harness=", "kind=other", "kind=", "session=",
  ])("rejects invalid query %s", async (query) => {
    const res = await app.request(`/api/calls?${query}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it("returns metadata without exposing bodies, quota headers, or request URLs", async () => {
    await ledger.record(call("private"), { request: "private request body", response: "private response body" });
    const detail = await app.request("/api/calls/private");
    expect(detail.status).toBe(200);
    expect(detail.headers.get("cache-control")).toBe("no-store");
    const { call: row } = await detail.json();
    expect(row).toMatchObject({ id: "private", inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 5, reasoningTokens: 2 });
    expect(row).not.toHaveProperty("quota");
    expect(row).not.toHaveProperty("path");
    expect(row).not.toHaveProperty("requestGz");
    expect(row).not.toHaveProperty("responseGz");
    const list: CallList = await (await app.request("/api/calls")).json();
    expect(list.calls).toEqual([row]);
    expect(JSON.stringify(row)).not.toContain("private-value");
  });

  it.each(["/api/calls", "/api/calls/existing"])("returns a safe JSON error when reading %s fails", async (path) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(ledger.db, "select").mockImplementation(() => {
      throw new Error("sensitive SQL and database path");
    });

    const res = await app.request(path);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "unable to read recorded calls" });
    expect(log).toHaveBeenCalledWith("[api] request failed");
    expect(JSON.stringify(log.mock.calls)).not.toContain("sensitive");
  });

  it("returns 404 for missing calls, unknown API routes, and write methods without proxying", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not proxy API requests"));
    ledger.db.insert(calls).values(call("existing")).run();
    for (const [path, method] of [
      ["/api/calls/missing", "GET"], ["/api/unknown", "GET"], ["/api", "GET"],
      ["/api/calls", "POST"], ["/api/calls/existing", "DELETE"], ["/api/calls/existing", "PATCH"],
    ]) {
      const res = await app.request(path!, { method });
      expect(res.status).toBe(404);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(ledger.db.select({ id: calls.id }).from(calls).all()).toEqual([{ id: "existing" }]);
  });
});
