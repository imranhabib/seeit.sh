import type { RecordedCall } from "@seeit/core";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import type { LedgerDatabase } from "./db/database.ts";
import { MAX_RECORDING_BYTES, checkRecordedCall, createVersionCheck } from "./ingest.ts";

// These checks happen before the database is used, so no PostgreSQL is needed.
const noDatabase = {} as LedgerDatabase;
const app = createApp(noDatabase, { writeToken: "secret-token" });

const body = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const valid = (): RecordedCall => ({
  id: "c1",
  startedAt: "2026-11-18T00:00:00.000Z",
  harness: "claude",
  method: "POST",
  path: "/v1/messages",
  turnId: null,
  request: { headers: { "user-agent": "claude-cli/2.1.326" }, body: "{}" },
  response: { status: 200, headers: { "content-type": "text/event-stream" }, body, pieces: [[10, 50], [body.length - 10, 60]] },
  timeToResponseHeadersMs: 40,
  timeToFirstChunkMs: 50,
  timeToStreamEndMs: 60,
  clientAborted: false,
  readFailed: false,
});

const post = (payload: unknown, token = "secret-token") =>
  app.request("/ingest/calls", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload) });

describe("POST /ingest/calls without a database", () => {
  it("rejects a missing or wrong token", async () => {
    expect((await app.request("/ingest/calls", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await post(valid(), "wrong")).status).toBe(401);
  });

  it("rejects a body that is not JSON, or not a recorded call, and names the problem", async () => {
    const notJson = await app.request("/ingest/calls", { method: "POST", headers: { authorization: "Bearer secret-token" }, body: "{" });
    expect(notJson.status).toBe(400);
    const bad = await post({ ...valid(), harness: "other" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'harness must be "claude" or "codex"' });
  });

  it("rejects a recording over the size limit", async () => {
    const huge = await app.request("/ingest/calls", {
      method: "POST",
      headers: { authorization: "Bearer secret-token", "content-length": String(MAX_RECORDING_BYTES + 1) },
      body: "x",
    });
    expect(huge.status).toBe(413);
  });
});

describe("checkRecordedCall", () => {
  it("accepts a valid call, including one upstream never answered", () => {
    expect(checkRecordedCall(valid())).toBeNull();
    expect(checkRecordedCall({ ...valid(), response: { status: null, headers: {}, body: null, pieces: [] }, timeToFirstChunkMs: null })).toBeNull();
  });

  it.each([
    ["id", { id: "" }, "id must be a string of 1-200 characters"],
    ["startedAt", { startedAt: "yesterday" }, "startedAt must be an ISO 8601 time"],
    ["headers", { request: { headers: { a: 1 }, body: null } }, "request must have string headers and a string or null body"],
    ["status", { response: { ...valid().response, status: 42 } }, "response.status must be an HTTP status or null"],
    ["pieces", { response: { ...valid().response, pieces: [[1, "x"]] } }, "response.pieces must be [characters, ms] pairs"],
    ["coverage", { response: { ...valid().response, pieces: [[3, 50]] } }, "response.pieces must add up to the body length"],
    ["flags", { clientAborted: "no" }, "clientAborted and readFailed must be booleans"],
  ])("names a bad %s", (_name, change, problem) => {
    expect(checkRecordedCall({ ...valid(), ...change })).toBe(problem);
  });
});

describe("createVersionCheck", () => {
  it("flags one of several calls from a new version that arrive at the same moment", async () => {
    const isFirstUntested = createVersionCheck();
    let asked = 0;
    // The database is slow to answer, so all calls are in flight together.
    const hasEarlier = () => new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10 + asked++));
    const answers = await Promise.all(Array.from({ length: 5 }, () => isFirstUntested("claude-cli/9.9.9", hasEarlier)));
    expect(answers.filter(Boolean)).toHaveLength(1);
    expect(asked).toBe(1);
  });

  it("asks the database for a version this process has not seen, and never for a tested one", async () => {
    const isFirstUntested = createVersionCheck();
    expect(await isFirstUntested("claude-cli/9.9.9", async () => true)).toBe(false); // an earlier checked row exists
    expect(await isFirstUntested("claude-cli/2.1.322", async () => false)).toBe(false); // has a fixture
    expect(await isFirstUntested(null, async () => false)).toBe(false);
  });
});
