# 0008 — Turn assignment moves to the ledger; real-time turns are best effort

**Status:** accepted; implementation pending

## Context

Today the gateway assigns each call to a turn (`apps/gateway/src/turns.ts`).
It keeps the current turn of each session in memory and judges every call
against it, so it must see calls in request order. That has two costs:

- The state lives in one gateway process, so gateway replicas would need to
  share it (PLAN.md, service boundaries).
- Under ADR 0007 the gateway sends recordings to the ledger after each
  response ends, with retries. The ledger receives calls in finish order, not
  request order, so it cannot simply run the same tracker on arrival.

Where turn IDs come from:

- **Codex** sends its turn ID on each request (`x-codex-turn-metadata`:
  `turn_id`, and `root_turn_id` for subagents).
- **Claude Code** sends `x-claude-code-prompt-id`, a UUID shared by every
  request that serves one user prompt, including the subagent turns that the
  prompt started. It is one of the "gateway hint headers" (Claude Code v2.1.283
  or later), which are off by default for a custom base URL. They are turned on
  with `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`
  ([gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol)).
  Without it, Claude Code sends no turn ID and turns must be inferred.
- Providers send no turn ID: a turn is the harness's idea. Response IDs
  (`msg_…`, `resp_…`, `request-id`) are per call.

## Decision

1. **The ledger assigns turns.** The gateway keeps no turn state.
2. **An explicit turn ID wins.** In order:
   1. The harness's own ID: Codex `root_turn_id` or `turn_id`, Claude Code
      `x-claude-code-prompt-id`.
   2. Otherwise, inference: today's rules (new user text starts a turn;
      subagent calls never start one; retries and resumes stay in their turn;
      background calls join the turn in progress).
3. **Inference uses request order.** The gateway stamps each call with
   `startedAt` (when the request arrived) and a sequence number per gateway
   process, to break ties. The ledger orders a session's calls by
   `(startedAt, seq)`. Provider timestamps and ledger arrival time are not
   used.
4. **Turn inputs are stored on each call,** as columns that outlive body
   retention: session ID, `startedAt`, sequence number, kind, agent ID,
   explicit turn ID, whether the request starts a turn, and the turn key
   (block hashes, not text). The ledger derives them from the request body it
   receives: parsing runs in the ledger (PLAN.md, service boundaries,
   decided 2026-11-18).
5. **Turn IDs are deterministic.** An explicit ID is used as is. An inferred
   turn takes the ID of the call that started it. Recomputing a session gives
   the same IDs, except for turns that a late call really changes.
6. **Recompute instead of waiting.** A call that started after every stored
   call of its session is appended: one inference step. A call that started
   earlier than the latest stored call triggers a replay of that session in
   `(startedAt, seq)` order, updating changed turn IDs.
7. **Real-time turns are best effort.** A recent session's turns are
   provisional and can change when a late call arrives. A session is settled
   after a quiet period with no new calls. The dashboard can show provisional
   turns as such.

## Consequences

- Gateway replicas no longer need shared turn state. Their `startedAt` clocks
  must be synchronized; ties across gateways also need a gateway ID, because
  sequence numbers are per process.
- The gateway no longer needs `turns.ts`. It still needs some request
  parsing for budget checks before the upstream request (ADR 0004).
- Results that depend on a turn must follow it: the `turn_without_turn_id`
  flag, per-turn totals, and per-turn analysis are computed after assignment
  and again after a recompute (or computed when read).
- With the hint headers on, Claude Code main and subagent calls are
  independent of arrival order, like Codex turn calls. Order matters only for
  calls without an explicit ID: Claude Code requests "not attributed to a
  prompt" (for example `auxiliary` side requests), Codex background calls, and
  Claude Code versions or setups without the header.
- A call lost for good (ADR 0007, v1 best-effort delivery) cannot be repaired.
  If it started a turn, an inferred turn merges into the previous one.
  Sequence gaps make such losses visible. A call that arrives late after a
  retry is repaired by the recompute.
- Setup documentation must tell Claude Code users to set
  `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`. Iris sets it for its Claude Code runs,
  and an Iris check compares the inferred turns with the header's prompt IDs.
- The parser change (read `x-claude-code-prompt-id` as the explicit turn ID,
  with inference as the fallback) does not depend on the ledger and can land
  first, in today's gateway tracker.

## Not decided here

- The length of the quiet period before a session is settled.
- Whether the other hint headers (`x-claude-code-request-class`,
  `x-claude-code-compaction`) replace or only check today's kind inference.
  Iris runs decide this.
