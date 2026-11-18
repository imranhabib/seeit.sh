// The one invariant check that needs earlier rows (ADR 0005, layer 3): the
// first call from a harness version with no fixture. The other checks are
// callFlags in @seeit/core.

import { hasFixture } from "@seeit/core";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Ledger } from "./db/ledger.ts";
import { calls } from "./db/schema.ts";

/**
 * Tells whether a call is the first one from a harness version with no
 * fixture. Asks the ledger, so the answer survives gateway restarts
 * (`pnpm dev` restarts on every save). Must be asked before the row is written.
 *
 * Only rows that were checked count as earlier calls (flags not null). A
 * version seen only in rows recorded before these checks existed was never
 * flagged, so its first checked call is.
 *
 * Two calls from a new version that arrive at the same moment can both be
 * flagged; that is harmless.
 */
export function createVersionCheck(ledger: Ledger) {
  // Versions already seen, so the ledger is asked at most once per version
  // per gateway run.
  const seen = new Set<string>();

  return function isFirstUntested(harnessVersion: string | null | undefined): boolean {
    if (!harnessVersion || hasFixture(harnessVersion) || seen.has(harnessVersion)) return false;
    seen.add(harnessVersion);
    const earlier = ledger.db
      .select({ id: calls.id })
      .from(calls)
      .where(and(eq(calls.harnessVersion, harnessVersion), isNotNull(calls.flags)))
      .limit(1)
      .all();
    return earlier.length === 0;
  };
}
