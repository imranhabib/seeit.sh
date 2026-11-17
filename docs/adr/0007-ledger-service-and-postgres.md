# 0007 — Separate ledger service with PostgreSQL

**Status:** accepted; implementation pending

Keep gateway, ledger, and dashboard in one monorepo, with gateway and ledger
running as separate services. The ledger owns PostgreSQL access, ingestion,
reads, migrations, retention, and analysis. The gateway sends recordings over
HTTP outside its client response path; the dashboard and CLI use read-only HTTP
access. This isolates database and dashboard work from the proxy event loop
and allows separate cloud deployment without sharing database files.

This supersedes the SQLite storage choice in ADR 0003 while preserving its
ledger-plus-Langfuse division. It also replaces the gateway-mounted read API
proposed in [PR #5](https://github.com/imranhabib/seeit.sh/pull/5); that PR's
metadata selection, validation, and tests can be reused in the ledger service.
ADR number 0006 is reserved by that PR.

## Deployment and delivery

- Support native local operation with separate Node services and locally
  installed PostgreSQL, with no Docker requirement for setup, tests, or use.
- Also support local Compose with one container per service and a persistent
  PostgreSQL volume. Cloud deployments run gateway and ledger containers on
  separate instances; PostgreSQL remains a separate process/container owned
  by the ledger and can be hosted separately.
- Use the same HTTP contract, authenticated write access, timeouts, bounded
  retries/queues, and stable-ID idempotency in all modes. Acknowledgements mean
  committed transactions. Ledger failures must not block provider streaming.
- Decide and verify queue-overflow and restart-durability behavior before
  replacing the current recording path. An in-memory queue cannot guarantee
  survival across gateway restarts. No lossless-delivery claim is implied.
- Containers use the same application entry points as native execution.
  PostgreSQL is the single target database. Importing existing SQLite data
  requires an explicit cutover plan; do not keep dual runtime database engines.

## Tradeoffs

This adds HTTP delivery failures and database operations that embedded SQLite
did not require. Separate processes still share resources when colocated.
Native setup requires PostgreSQL installation; Docker setup adds containers
and volume management. Independent cloud scaling also needs coordination of
the gateway's current in-memory turn state and future budget counters.
