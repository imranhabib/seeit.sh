// Decides whether a recorded scenario passed.
//
// Two sources are compared: what the gateway wrote to the ledger (rows) and
// what the chaos proxy saw on its own (observed). Rules are about structure,
// never about the model's words. Returns one line per problem; empty = pass.

import type { Observed } from "./chaos-proxy.ts";
import type { CallRecord } from "./results.ts";
import type { Scenario } from "./scenarios.ts";

export type ScenarioEvidence = {
  /** Exit code of each step's harness process. */
  exitCodes: (number | null)[];
  rows: CallRecord[];
  observed: Observed[];
  /** The scenario's fault (cut / interrupt) really happened. */
  faultHappened: boolean;
};

/** The only flag a healthy call may carry: its harness version has no fixture yet. */
const ALLOWED_FLAGS = new Set(["untested_harness_version"]);

export function checkScenario(scenario: Scenario, e: ScenarioEvidence): string[] {
  const problems: string[] = [];
  const turnRows = e.rows.filter((r) => r.kind === "turn");
  const count = (rows: CallRecord[], completion: string) => rows.filter((r) => r.completion === completion).length;

  // --- Rules for every scenario ------------------------------------------

  e.exitCodes.forEach((code, i) => {
    // Ctrl+C makes the interrupted step exit non-zero; that is the point.
    const interrupted = i === 0 && scenario.fault?.action === "interrupt";
    if (code !== 0 && !interrupted) problems.push(`step ${i + 1} exited with code ${code}`);
  });

  if (scenario.fault && !e.faultHappened) problems.push(`the ${scenario.fault.action} never happened (no turn stream reached ${scenario.fault.afterTextDeltas} text deltas)`);

  if (e.rows.length !== e.observed.length) problems.push(`the gateway recorded ${e.rows.length} calls, the proxy saw ${e.observed.length}`);

  for (const row of e.rows) {
    const at = `${row.method} ${row.path.split("?")[0]} (${row.kind}, ${row.completion})`;
    const flags: string[] = row.flags ? JSON.parse(row.flags) : [];
    const unexpected = flags.filter((f) => !ALLOWED_FLAGS.has(f));
    if (unexpected.length) problems.push(`${at}: flags ${unexpected.join(", ")}`);
    if (row.unknown_events && row.unknown_events !== "{}") problems.push(`${at}: unknown events ${row.unknown_events}`);
    if (row.unknown_usage_fields && row.unknown_usage_fields !== "[]") problems.push(`${at}: unknown usage fields ${row.unknown_usage_fields}`);
    if (row.kind !== "turn") continue;
    if (!row.turn_id) problems.push(`${at}: turn call without a turn ID`);
    if (row.completion === "complete") {
      if (row.input_tokens === null || row.output_tokens === null) problems.push(`${at}: complete but no usage`);
      if (row.tokens_estimated) problems.push(`${at}: complete but tokens are estimated`);
    } else if (!row.tokens_estimated) {
      problems.push(`${at}: not complete, but tokens are not marked estimated`);
    }
  }

  // Every call with a session ID belongs to a turn once the session's first
  // turn has started (turns.ts links background calls by session).
  const firstTurnAt = new Map<string, CallRecord>();
  for (const r of turnRows) if (r.session_id && r.turn_id && !firstTurnAt.has(r.session_id)) firstTurnAt.set(r.session_id, r);
  for (const r of e.rows) {
    const first = r.session_id ? firstTurnAt.get(r.session_id) : undefined;
    if (r.turn_id || !first || r.started_at < first.started_at || r.kind === "connectivity") continue;
    problems.push(`${r.method} ${r.path.split("?")[0]} (${r.kind}, ${r.completion}): has a session ID but no turn, although turn ${first.turn_id} was in progress`);
  }

  // Both sides must agree on which streams started but did not finish.
  // (An upstream_error from an HTTP error status is not a stream.)
  const proxyUnfinished = e.observed.filter((o) => o.stream && !o.final).length;
  const ledgerUnfinished = count(e.rows, "upstream_dropped") + count(e.rows, "client_aborted");
  if (proxyUnfinished !== ledgerUnfinished) problems.push(`the proxy saw ${proxyUnfinished} unfinished stream(s), the ledger has ${ledgerUnfinished} dropped or aborted call(s)`);

  // Isolation: nothing from the user's own setup may reach a request.
  const leaks = new Set(e.observed.flatMap((o) => Object.keys(o.markers).filter((m) => m.startsWith("request:leak-"))));
  for (const leak of leaks) problems.push(`isolation: ${leak.slice("request:".length)} found in a request`);

  // --- Rules from the scenario's expectations ------------------------------

  const want = scenario.expect;
  const known = new Set(want.knownFailures ?? []);
  const counted = e.rows.filter((r) => !(r.completion === "upstream_error" && known.has(`${r.method} ${r.path.split("?")[0]}`)));
  for (const status of ["upstream_dropped", "client_aborted", "upstream_error", "gateway_error"] as const) {
    const expected = (want.incomplete as Record<string, number> | undefined)?.[status] ?? 0;
    const got = count(counted, status);
    if (got !== expected) problems.push(`expected ${expected} ${status} call(s), got ${got}`);
  }

  const turnIds = new Set(turnRows.map((r) => r.turn_id).filter(Boolean));
  if (want.turns !== undefined && turnIds.size !== want.turns) problems.push(`expected ${want.turns} turn(s), got ${turnIds.size}`);

  for (const marker of want.saw ?? []) {
    if (!e.observed.some((o) => o.markers[marker])) problems.push(`no call contained ${marker}: the scenario did not exercise its feature`);
  }

  if (want.subagents) {
    const agentRows = turnRows.filter((r) => r.agent_id);
    const agents = new Set(agentRows.map((r) => r.agent_id));
    const mainTurns = new Set(turnRows.filter((r) => !r.agent_id).map((r) => r.turn_id));
    if (agents.size < want.subagents) problems.push(`expected calls from at least ${want.subagents} subagent(s), got ${agents.size}`);
    if (agentRows.some((r) => !mainTurns.has(r.turn_id))) problems.push("a subagent call is not in its parent's turn");
  }

  return problems;
}
