// Invariant checks on every ledger row (ADR 0005, layer 3).
//
// Each flag names a rule that should always hold. A flagged row is not
// necessarily wrong, but it is worth a look: it often means a harness or
// provider changed its format. Flags are stored on the row, never used to
// block or change a call.

import { hasFixture, type StreamSummary } from "@seeit/core";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Ledger } from "./db/ledger.ts";
import { calls, type CallRow } from "./db/schema.ts";

export type Flag =
  | "complete_without_usage" // the provider finished but we found no token counts
  | "turn_without_turn_id" // a turn call that got no turn ID (no session ID, or the harness sent none)
  | "estimated_on_complete" // a finished call should have real counts, not estimates
  | "untested_harness_version" // first call from a version with no fixture
  | "model_changed_without_fallback" // the model at the end differs from the start, with nothing to explain it
  | "fallback_usage_partial" // server-side fallback: usage covers only the serving model; declined attempts are billed too
  | "input_changed_without_server_tool"; // input grew during the stream, but no server tool ran

type Checked = Pick<CallRow, "kind" | "completion" | "turnId" | "inputTokens" | "outputTokens" | "tokensEstimated">;
type StreamFacts = Pick<StreamSummary, "startModel" | "model" | "fallback" | "startInputTokens" | "serverToolUse" | "serverToolSeen">;

/** Rules that need only the row, plus what the response stream showed (null when there was none to read). */
export function callFlags(row: Checked, stream: StreamFacts | null = null): Flag[] {
  const flags: Flag[] = [];
  const complete = row.completion === "complete";
  // Only turns are checked for usage and turn ID: background and
  // connectivity calls legitimately have neither.
  if (row.kind === "turn" && complete && (row.inputTokens == null || row.outputTokens == null)) flags.push("complete_without_usage");
  if (row.kind === "turn" && !row.turnId) flags.push("turn_without_turn_id");
  if (complete && row.tokensEstimated) flags.push("estimated_on_complete");
  if (!stream) return flags;

  // PLAN.md streaming gap 1. Anthropic explains a model change with a fallback
  // block; OpenAI has no such feature, so any change there is unexplained.
  if (stream.startModel && stream.model && stream.startModel !== stream.model && !stream.fallback) flags.push("model_changed_without_fallback");
  // Each attempt is billed, but the top-level usage only counts the last one
  // (the others are in usage.iterations). Flagged until Phase 2 prices them.
  if (stream.fallback) flags.push("fallback_usage_partial");
  // PLAN.md streaming gap 2. Only server tools (search results become input)
  // or a fallback (another model counts differently) should change input
  // between message_start and the final message_delta.
  const serverTool = stream.serverToolSeen || Object.keys(stream.serverToolUse ?? {}).length > 0;
  if (
    complete &&
    stream.startInputTokens != null &&
    row.inputTokens != null &&
    row.inputTokens !== stream.startInputTokens &&
    !serverTool &&
    !stream.fallback
  ) {
    flags.push("input_changed_without_server_tool");
  }
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
