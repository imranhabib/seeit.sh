# 0005 — Parser coverage: spec tests, risk-ranked recordings, live drift checks

**Status:** accepted

## Context

The gateway parses traffic it does not control. Claude Code and Codex change
their request and response formats between versions without notice (Codex
0.153 → 0.169 moved tools and instructions into `input`). Phase 1 fixtures were
three one-shot "pong" calls, which prove the plumbing but not real agent
sessions (tool loops, subagents, compaction, hooks, resume).

Research (2026-11-14) found:

- **Official schemas cover most fields but not behavior or backend extras.**
  Anthropic's SDK beta types and [streaming
  docs](https://platform.claude.com/docs/en/build-with-claude/streaming);
  OpenAI's [openai-openapi](https://github.com/openai/openai-openapi) spec; for
  the ChatGPT backend, only the open-source Codex client
  (`codex-rs/codex-api/src/`). The Anthropic docs require clients to "handle
  unknown event types gracefully".
- **No project publishes wire-level recordings of agent sessions.** Other
  gateways (LiteLLM, claude-code-proxy, laudec) parse untyped JSON and read a
  few fields. LiteLLM adds a typed-then-fallback path, interrupted-stream
  output recovery, hand-written wire tests, and sanitized scenario recordings
  of harness CLI output.
- See also [docs/research/gateway-schema-handling.md](../research/gateway-schema-handling.md),
  which separates **forwarding compatibility** (unknown fields reach the
  harness untouched) from **accounting completeness** (the parser reads them):
  the two need separate checks.

Recording "as many scenarios as possible" does not work alone: rare cases
(fallback, overload errors, dropped connections) cannot be triggered on demand,
combinations are endless, and recordings go stale with each harness release.

## Decision

The goal is: **know which fields the gateway depends on, test them from several
sources, and let the gateway report its own blind spots on real traffic.** Four
layers:

1. **Spec-derived tests.** Small streams written from the official docs, SDK
   types, OpenAI spec, and Codex source, for documented cases that are rare or
   cannot be triggered (fallback, mid-stream errors, server tools, several
   `message_delta` events, whole blocks without deltas). Each test links the
   source it was written from.
2. **Risk-ranked recordings.** Record only scenarios where the gateway makes a
   decision with a heuristic: long tool loops, subagents, compaction,
   interrupt-then-resume, hooks that inject context, server tools, visible
   thinking. About 8–10 per supported harness version, each with **written
   expected results**. Recorded in a throwaway sandbox repo with dummy content,
   with request bodies redacted, then reviewed by hand.
3. **Live drift detection.** The gateway checks its own traffic: it counts
   unknown event types and usage fields, checks invariants (for example
   `complete` but no usage, or the model changing between `message_start` and
   the final `message_delta` without a fallback block), and flags the first
   call from a harness version with no fixtures. Flags are stored on the
   ledger row.
4. **Flagged calls become fixtures.** Bodies are kept 14 days, so a flagged
   call can be turned into a redacted fixture, reviewed, given an expected
   result, and fixed against.

The parser stays **fail-soft**: unknown events are ignored, missing usage
becomes an estimate with a flag, completion is decided from events. A new
format must produce "estimated and flagged", never "wrong and silent".

## Consequences

- Layer 3 comes first: it is small and protects real usage immediately.
- Each supported harness version needs a small fixture set; versions in use
  without one are visible in the ledger.
- Fixture provenance must be recorded (spec link, or harness version and
  scenario) so a failing test points to its cause.
- Recording sessions use real subscription quota; scenarios are chosen by risk
  to keep that small.
