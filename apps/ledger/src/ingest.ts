// Recording ingestion (ADR 0007): POST /ingest/calls.
//
// The gateway sends one RecordedCall per proxied call, after the response
// ended: redacted headers, decoded bodies, and what only the gateway knows.
// The ledger analyzes it (analyzeCall in @seeit/core), adds the version
// check, and stores the call and its bodies in one transaction.
//
// Delivery rules (PLAN.md, "Recording delivery rules"):
// - The call ID is the idempotency key. A retry of a stored call is
//   acknowledged as a duplicate and changes nothing.
// - 201/200 are sent only after the transaction commits.
// - Errors never echo request content, SQL, or connection details.

import { createHash, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { analyzeCall, hasFixture, type RecordedCall } from "@seeit/core";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Context } from "hono";
import type { LedgerDatabase } from "./db/database.ts";
import { bodies, calls } from "./db/schema.ts";

const gzipAsync = promisify(gzip);

/** Largest accepted recording. Request bodies reach hundreds of KB; long streams a few MB. */
export const MAX_RECORDING_BYTES = 64 * 1024 * 1024;

export function createIngest(database: LedgerDatabase, writeToken: string) {
  const expected = digest(writeToken);
  const isFirstUntested = createVersionCheck();

  return async function ingest(c: Context) {
    // Compare digests in constant time, so the response time says nothing about the token.
    const given = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
    if (!given || !timingSafeEqual(digest(given), expected)) return c.json({ error: "unauthorized" }, 401);

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "body is not JSON" }, 400);
    }
    const problem = checkRecordedCall(payload);
    if (problem) return c.json({ error: problem }, 400);
    const call = payload as RecordedCall;

    const { fields, error } = analyzeCall(call);
    // Never log the error itself: it can quote request or response content.
    if (error !== undefined) console.error(`[ledger] analysis failed for call ${call.id}; stored as gateway_error`);

    // gzip runs on libuv's thread pool, outside the transaction.
    const [requestGz, responseGz] = await Promise.all([
      call.request.body ? gzipAsync(call.request.body) : null,
      call.response.body ? gzipAsync(call.response.body) : null,
    ]);
    const startedAt = new Date(fields.startedAt);

    try {
      const stored = await database.db.transaction(async (tx) => {
        // ADR 0005, layer 3: flag the first checked call from a harness
        // version with no fixture. Asked before this row is written.
        const flags: string[] = [...fields.flags];
        const version = fields.harnessVersion;
        const hasEarlier = async () =>
          (await tx.select({ id: calls.id }).from(calls).where(and(eq(calls.harnessVersion, version!), isNotNull(calls.flags))).limit(1)).length > 0;
        if (await isFirstUntested(version, hasEarlier)) flags.push("untested_harness_version");
        const inserted = await tx
          .insert(calls)
          .values({ ...fields, startedAt, flags })
          .onConflictDoNothing({ target: calls.id })
          .returning({ id: calls.id });
        if (inserted.length === 0) return false; // already stored: a retry
        await tx.insert(bodies).values({ callId: call.id, createdAt: startedAt, requestGz, responseGz });
        return true;
      });
      return stored ? c.json({ status: "stored" }, 201) : c.json({ status: "duplicate" }, 200);
    } catch {
      console.error(`[ledger] storing call ${call.id} failed`);
      return c.json({ error: "storage unavailable" }, 503);
    }
  };
}

/**
 * Tells whether a call is the first one from a harness version with no
 * fixture (ADR 0005, layer 3), like createVersionCheck in the gateway. The
 * database answers across restarts; the set of versions already checked
 * answers within this process, and is filled before the database is asked,
 * so calls that arrive at the same moment are not all flagged (Codex sends
 * two GET /models a few ms apart).
 */
export function createVersionCheck() {
  const seen = new Set<string>();
  return async function isFirstUntested(version: string | null, hasEarlierCheckedCall: () => Promise<boolean>): Promise<boolean> {
    if (!version || hasFixture(version) || seen.has(version)) return false;
    seen.add(version);
    return !(await hasEarlierCheckedCall());
  };
}

function digest(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

const isString = (v: unknown): v is string => typeof v === "string";
const isNullableString = (v: unknown) => v === null || isString(v);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringRecord = (v: unknown) => isObject(v) && Object.values(v).every(isString);

/** The first problem with a payload, or null when it is a valid RecordedCall. */
export function checkRecordedCall(v: unknown): string | null {
  if (!isObject(v)) return "body must be an object";
  if (!isString(v.id) || v.id.length === 0 || v.id.length > 200) return "id must be a string of 1-200 characters";
  if (!isString(v.startedAt) || Number.isNaN(Date.parse(v.startedAt))) return "startedAt must be an ISO 8601 time";
  if (v.harness !== "claude" && v.harness !== "codex") return 'harness must be "claude" or "codex"';
  if (!isString(v.method) || !isString(v.path)) return "method and path must be strings";
  if (!isNullableString(v.turnId)) return "turnId must be a string or null";

  const req = v.request;
  if (!isObject(req) || !isStringRecord(req.headers) || !isNullableString(req.body)) return "request must have string headers and a string or null body";

  const res = v.response;
  if (!isObject(res) || !isStringRecord(res.headers) || !isNullableString(res.body)) return "response must have string headers and a string or null body";
  if (res.status !== null && !(Number.isInteger(res.status) && (res.status as number) >= 100 && (res.status as number) <= 599)) return "response.status must be an HTTP status or null";
  if (!Array.isArray(res.pieces) || !res.pieces.every((p) => Array.isArray(p) && p.length === 2 && Number.isInteger(p[0]) && p[0] >= 0 && isNumber(p[1]))) {
    return "response.pieces must be [characters, ms] pairs";
  }
  // The pieces must cover the body exactly, or replaying them would cut it wrongly.
  const covered = (res.pieces as [number, number][]).reduce((n, [length]) => n + length, 0);
  if (covered !== ((res.body as string | null)?.length ?? 0)) return "response.pieces must add up to the body length";

  if (!isNumber(v.timeToResponseHeadersMs) || !isNumber(v.timeToStreamEndMs)) return "timeToResponseHeadersMs and timeToStreamEndMs must be numbers";
  if (v.timeToFirstChunkMs !== null && !isNumber(v.timeToFirstChunkMs)) return "timeToFirstChunkMs must be a number or null";
  if (typeof v.clientAborted !== "boolean" || typeof v.readFailed !== "boolean") return "clientAborted and readFailed must be booleans";
  return null;
}
