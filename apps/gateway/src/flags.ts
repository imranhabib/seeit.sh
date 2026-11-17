// Invariant checks on every ledger row (ADR 0005, layer 3).
//
// Each flag names a rule that should always hold. A flagged row is not
// necessarily wrong, but it is worth a look: it often means a harness or
// provider changed its format. Flags are stored on the row, never used to
// block or change a call.
//
// More rules arrive with the streaming-gap fixes (PLAN.md follow-up step 2):
// model changed without a fallback block, input changed without server tools.

import { hasFixture } from "@seeit/core";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Ledger } from "./db/ledger.ts";
import { calls, type CallRow } from "./db/schema.ts";

export type Flag =
  | "complete_without_usage" // the provider finished but we found no token counts
  | "turn_without_turn_id" // a turn call that got no turn ID (no session ID, or the harness sent none)
  | "estimated_on_complete" // a finished call should have real counts, not estimates
  | "untested_harness_version"; // first call from a version with no fixture

type Checked = Pick<CallRow, "kind" | "completion" | "turnId" | "inputTokens" | "outputTokens" | "tokensEstimated">;

/** Rules that need only the row itself. */
export function callFlags(row: Checked): Flag[] {
  const flags: Flag[] = [];
  const complete = row.completion === "complete";
  // Only turns are checked for usage and turn ID: background and
  // connectivity calls legitimately have neither.
  if (row.kind === "turn" && complete && (row.inputTokens == null || row.outputTokens == null)) flags.push("complete_without_usage");
  if (row.kind === "turn" && !row.turnId) flags.push("turn_without_turn_id");
  if (complete && row.tokensEstimated) flags.push("estimated_on_complete");
  return flags;
}

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
