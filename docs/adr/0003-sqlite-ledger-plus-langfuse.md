# 0003 — SQLite ledger plus Langfuse traces

**Status:** accepted

## Decision

The gateway has two outputs:

1. **A SQLite ledger**: one row per call (harness, session, turn, model,
   tokens by type, estimated cost, latency) plus gzipped bodies. It is the
   source of truth for budgets and the custom dashboard.
2. **OpenTelemetry traces** (GenAI semantic conventions) exported to a
   self-hosted Langfuse for general trace and session browsing.

## Why

- Budgets need a local, fast, queryable record the gateway owns.
- Langfuse gives a good LLM trace UI without building one.
- The differentiating views (context breakdown, cache breaks, waste) do not fit
  in Langfuse, so they get a custom dashboard on top of the ledger.

## Rejected

- **Grafana + Postgres/ClickHouse only**: flexible charts, weak trace view.
- **Building every UI**: a lot of work that teaches little about gateways.

## Consequences

- Full bodies grow roughly quadratically per session (each call resends the
  whole conversation). Mitigation in v1: gzip and 14-day retention. Delta
  storage is a later learning exercise.
