// Request and response bodies hold prompts and code, so they are kept for a
// limited time. Call rows (metadata and usage) are kept forever (PLAN.md,
// "Retention and ledger API").

import { lt } from "drizzle-orm";
import type { LedgerDatabase } from "./database.ts";
import { bodies } from "./schema.ts";

export const BODY_RETENTION_DAYS = 14;

/** Delete bodies older than the retention period; returns how many. */
export async function pruneBodies(database: LedgerDatabase, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - BODY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await database.db.delete(bodies).where(lt(bodies.createdAt, cutoff)).returning({ callId: bodies.callId });
  return deleted.length;
}
