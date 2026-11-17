import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Ledger } from "./db/ledger.ts";
import { calls } from "./db/schema.ts";

// Select public metadata explicitly so new ledger columns do not become API
// fields by accident. Bodies and raw quota headers have separate future views.
const callFields = {
  id: calls.id,
  startedAt: calls.startedAt,
  harness: calls.harness,
  harnessVersion: calls.harnessVersion,
  sessionId: calls.sessionId,
  turnId: calls.turnId,
  kind: calls.kind,
  model: calls.model,
  httpStatus: calls.httpStatus,
  completion: calls.completion,
  errorType: calls.errorType,
  inputTokens: calls.inputTokens,
  cacheReadTokens: calls.cacheReadTokens,
  cacheWriteTokens: calls.cacheWriteTokens,
  outputTokens: calls.outputTokens,
  reasoningTokens: calls.reasoningTokens,
  tokensEstimated: calls.tokensEstimated,
  timeToResponseHeadersMs: calls.timeToResponseHeadersMs,
  timeToFirstChunkMs: calls.timeToFirstChunkMs,
  timeToFirstTokenMs: calls.timeToFirstTokenMs,
  timeToStreamEndMs: calls.timeToStreamEndMs,
  toolsCount: calls.toolsCount,
  toolsChars: calls.toolsChars,
  instructionsChars: calls.instructionsChars,
};

export type CallMetadata = Pick<typeof calls.$inferSelect, keyof typeof callFields>;
export type CallList = { calls: CallMetadata[]; nextOffset: number | null };

export function createReadApi(ledger: Ledger) {
  const api = new Hono();

  // Usage changes after each completed call; browsers must not reuse old pages.
  api.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  api.get("/calls", (c) => {
    const query = c.req.query();
    const limit = readInteger(query.limit, 50, 1, 100);
    const offset = readInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    if (limit === null || offset === null) {
      return c.json({ error: "limit must be an integer from 1 to 100; offset must be a non-negative safe integer" }, 400);
    }
    if (query.harness !== undefined && query.harness !== "claude" && query.harness !== "codex") {
      return c.json({ error: "harness must be claude or codex" }, 400);
    }
    if (query.kind !== undefined && !["turn", "background", "connectivity"].includes(query.kind)) {
      return c.json({ error: "kind must be turn, background, or connectivity" }, 400);
    }
    if (query.session !== undefined && query.session.length === 0) {
      return c.json({ error: "session must not be empty" }, 400);
    }

    const rows = ledger.db.select(callFields).from(calls).where(and(
      query.harness === undefined ? undefined : eq(calls.harness, query.harness),
      query.session === undefined ? undefined : eq(calls.sessionId, query.session),
      query.kind === undefined ? undefined : eq(calls.kind, query.kind),
    )).orderBy(desc(calls.startedAt), desc(calls.id)).limit(limit + 1).offset(offset).all();

    // One extra row tells us whether another page exists without counting the
    // entire ledger. ID breaks ties when calls have the same start timestamp.
    return c.json({ calls: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null } satisfies CallList);
  });

  api.get("/calls/:id", (c) => {
    const call = ledger.db.select(callFields).from(calls).where(eq(calls.id, c.req.param("id"))).get();
    if (!call) return c.json({ error: "call not found" }, 404);
    return c.json({ call });
  });

  // Reserve /api so unknown paths and write methods cannot reach the proxy.
  api.all("*", (c) => c.json({ error: "API route not found" }, 404));
  return api;
}

function readInteger(value: string | undefined, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}
