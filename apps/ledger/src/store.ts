// Stores one analyzed call in the ADR 0009 data model, inside the caller's
// transaction: its user, session, turn, the call row, the request as pieces,
// the response, tool uses, quota windows, context parts, and the Codex model
// catalog.

import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { CONTEXT_ANALYSIS_VERSION, hashPiece, type AnalyzedCall, type RecordedCall } from "@seeit/core";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { LedgerDatabase } from "./db/database.ts";
import { bodies, bodyPieces, callPieces, calls, contextParts, modelCatalog, quotaWindows, sessions, toolUses, turns, users } from "./db/schema.ts";

const gzipAsync = promisify(gzip);

type Db = LedgerDatabase["db"];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** What storeCall needs that is slow to compute, prepared outside the transaction. */
export type PreparedCall = {
  /** The request pieces in order, with their hash and, for pieces not stored yet, their gzipped JSON. */
  pieces: { path: string; hash: string; cacheControl: Record<string, unknown> | null; json: string; gz: Buffer | null }[];
  responseGz: Buffer | null;
};

/** Pieces are stored once per user, harness, and scope: the session, or the call itself without one (ADR 0009). */
export const pieceScope = (a: AnalyzedCall) => a.fields.sessionId ?? a.fields.id;

/** Hash each piece, and gzip the ones this scope does not have yet (gzip runs on libuv's thread pool). */
export async function prepareCall(db: Db, call: RecordedCall, analyzed: AnalyzedCall): Promise<PreparedCall> {
  const pieces = analyzed.records.pieces.map((p) => ({ path: p.path, cacheControl: p.cacheControl, json: JSON.stringify(p.value), hash: hashPiece(p.value) }));
  const hashes = [...new Set(pieces.map((p) => p.hash))];
  const stored = hashes.length
    ? new Set(
        (
          await db
            .select({ hash: bodyPieces.hash })
            .from(bodyPieces)
            .where(and(eq(bodyPieces.userId, call.userId), eq(bodyPieces.harness, call.harness), eq(bodyPieces.scope, pieceScope(analyzed)), inArray(bodyPieces.hash, hashes)))
        ).map((r) => r.hash),
      )
    : new Set<string>();
  const gzipped = new Map<string, Buffer>();
  await Promise.all(
    pieces.filter((p) => !stored.has(p.hash) && !gzipped.has(p.hash)).map(async (p) => gzipped.set(p.hash, await gzipAsync(p.json))),
  );
  return {
    pieces: pieces.map((p) => ({ ...p, gz: gzipped.get(p.hash) ?? null })),
    responseGz: call.response.body ? await gzipAsync(call.response.body) : null,
  };
}

/**
 * Writes everything for one call. Returns false when the call ID is already
 * stored (a retry): nothing else is written then.
 */
export async function storeCall(tx: Tx, call: RecordedCall, analyzed: AnalyzedCall, prepared: PreparedCall, flags: string[]): Promise<boolean> {
  const { fields, records } = analyzed;
  const startedAt = new Date(fields.startedAt);
  const { userId, harness, sessionId, turnId } = fields;

  // The ledger creates a user the first time it sees the ID; no sign-in yet (ADR 0009).
  await tx.insert(users).values({ id: userId }).onConflictDoNothing();
  if (sessionId) {
    await tx
      .insert(sessions)
      .values({ userId, harness, id: sessionId, harnessVersion: fields.harnessVersion, firstCallAt: startedAt, lastCallAt: startedAt })
      .onConflictDoUpdate({
        target: [sessions.userId, sessions.harness, sessions.id],
        set: {
          firstCallAt: sql`least(${sessions.firstCallAt}, excluded.first_call_at)`,
          lastCallAt: sql`greatest(${sessions.lastCallAt}, excluded.last_call_at)`,
          harnessVersion: sql`coalesce(excluded.harness_version, ${sessions.harnessVersion})`,
        },
      });
  }

  // The call first, without its turn: the turn row points back at the call that started it.
  const inserted = await tx
    .insert(calls)
    .values({ ...fields, turnId: null, startedAt, harnessTurnStartedAt: fields.harnessTurnStartedAt ? new Date(fields.harnessTurnStartedAt) : null, flags })
    .onConflictDoNothing({ target: calls.id })
    .returning({ id: calls.id });
  if (inserted.length === 0) return false;

  if (turnId) {
    // The earliest call seen so far started the turn; a late call can move it (ADR 0008).
    await tx
      .insert(turns)
      .values({ id: turnId, userId, harness, sessionId, startedByCallId: fields.id, startedAt, source: analyzed.turnSource ?? "inferred" })
      .onConflictDoUpdate({
        target: turns.id,
        set: {
          startedByCallId: sql`case when excluded.started_at < ${turns.startedAt} then excluded.started_by_call_id else ${turns.startedByCallId} end`,
          startedAt: sql`least(${turns.startedAt}, excluded.started_at)`,
        },
      });
    await tx.update(calls).set({ turnId }).where(eq(calls.id, fields.id));
  }

  const scope = pieceScope(analyzed);
  const newPieces = [...new Map(prepared.pieces.filter((p) => p.gz).map((p) => [p.hash, p])).values()];
  await insertChunked(newPieces, (rows) =>
    tx
      .insert(bodyPieces)
      .values(rows.map((p) => ({ userId, harness, scope, hash: p.hash, gz: p.gz!, bytes: Buffer.byteLength(p.json), firstSeenAt: startedAt })))
      .onConflictDoNothing(),
  );
  await insertChunked(prepared.pieces, (rows, offset) =>
    tx.insert(callPieces).values(rows.map((p, i) => ({ callId: fields.id, ordinal: offset + i, path: p.path, hash: p.hash, cacheControl: p.cacheControl }))),
  );
  await tx.insert(bodies).values({ callId: fields.id, createdAt: startedAt, responseGz: prepared.responseGz });

  // A response can name the same tool use twice only by mistake; keep the first.
  const uses = [...new Map(records.toolUses.map((u) => [u.toolUseId, u])).values()];
  await insertChunked(uses, (rows) => tx.insert(toolUses).values(rows.map((u) => ({ callId: fields.id, ...u }))));
  await fillResultSizes(tx, userId, records.toolResults);

  await insertChunked(records.quotaWindows, (rows) =>
    tx.insert(quotaWindows).values(rows.map((w) => ({ callId: fields.id, harness, observedAt: startedAt, ...w, resetsAt: w.resetsAt ? new Date(w.resetsAt) : null }))),
  );
  await insertChunked(records.contextParts, (rows) =>
    tx.insert(contextParts).values(rows.map((p) => ({ callId: fields.id, ...p, analysisVersion: CONTEXT_ANALYSIS_VERSION }))),
  );

  if (records.modelCatalog.length) {
    const harnessVersion = fields.harnessVersion ?? clientVersion(call.path) ?? "unknown";
    for (const m of records.modelCatalog) {
      const row = { userId, harness, harnessVersion, callId: fields.id, observedAt: startedAt, ...m };
      // The newest observation wins.
      await tx
        .insert(modelCatalog)
        .values(row)
        .onConflictDoUpdate({ target: [modelCatalog.userId, modelCatalog.harness, modelCatalog.harnessVersion, modelCatalog.model], set: row, setWhere: sql`${modelCatalog.observedAt} <= excluded.observed_at` });
    }
  }
  return true;
}

/**
 * A request carries the results of earlier tool uses. Each result's size is
 * written once, on the tool use it answers, for the same user. A result that
 * arrives before its tool use is stored is not filled.
 */
async function fillResultSizes(tx: Tx, userId: string, results: { toolUseId: string; resultChars: number }[]) {
  const sizes = new Map(results.map((r) => [r.toolUseId, r.resultChars]));
  if (!sizes.size) return;
  const pending = await tx
    .select({ callId: toolUses.callId, toolUseId: toolUses.toolUseId })
    .from(toolUses)
    .innerJoin(calls, eq(calls.id, toolUses.callId))
    .where(and(inArray(toolUses.toolUseId, [...sizes.keys()]), isNull(toolUses.resultChars), eq(calls.userId, userId)));
  for (const p of pending) {
    await tx
      .update(toolUses)
      .set({ resultChars: sizes.get(p.toolUseId)! })
      .where(and(eq(toolUses.callId, p.callId), eq(toolUses.toolUseId, p.toolUseId)));
  }
}

// PostgreSQL allows 65,535 parameters per statement; 500 rows stay well below it.
async function insertChunked<T>(rows: T[], insert: (chunk: T[], offset: number) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += 500) await insert(rows.slice(i, i + 500), i);
}

// Codex GET /models?client_version=0.169.1, when the user-agent names no Codex version.
function clientVersion(path: string): string | null {
  return new URL(path, "http://ledger.invalid").searchParams.get("client_version");
}
