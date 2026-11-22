# seeit.sh

A local-first AI gateway for coding agents. It sits between **Claude Code** /
**Codex** and their model providers, records every call, and shows where your
tokens go, and why.

```
claude ──▶ ┌─────────────┐ ──▶ api.anthropic.com
           │   seeit.sh  │
codex  ──▶ └──────┬──────┘ ──▶ chatgpt.com/backend-api/codex
                  ▼
        recordings / ledger / dashboards
```

It works with **subscription logins** (Claude Max/Pro, ChatGPT). The gateway
passes your credentials through unchanged and never stores them.

## Status

| Phase | What | State |
| --- | --- | --- |
| 0 | Recorder spike: pass-through proxy that records redacted traffic | ✅ done |
| 1 | Stream parsing, usage, sessions and turns, completion, drift flags | ✅ done (cost estimates move to Phase 2) |
| 1C | Separate ledger service with PostgreSQL, background delivery from the gateway | ✅ ledger, ingestion, delivery, cutover, data model · next: turn assignment in the ledger, read API, Docker |
| 2 | Observability: prices, dashboard, Langfuse traces | planned |
| 3 | Budgets and blocking, repo attribution | planned |
| 4 | Transforms, model router | planned |

What to do next, in order, and the decisions in force are at the top of
[docs/PLAN.md](docs/PLAN.md). The key decisions are in [docs/adr/](docs/adr/).

## Architecture

```text
Claude Code / Codex ──▶ Gateway ──▶ Model provider
                          │
                          │ background HTTP recording
                          ▼
                      Ledger service ──▶ PostgreSQL
                          ▲
                          │ read-only HTTP access (planned)
                   Dashboard / CLI (planned)
```

- **Gateway** (`apps/gateway`, built): forwards raw traffic and streams
  provider responses immediately. It scrubs credentials from its recording
  copy, then sends each call to the ledger in the background. It has no
  database.
- **Ledger** (`apps/ledger`, built): takes recorded calls over authenticated
  HTTP, analyzes them with `@seeit/core`, and stores them in PostgreSQL. It
  owns migrations and, later, the read API.
- **Dashboard** (planned): explains session token use, context composition,
  cache behavior, compaction, and quota. It will work standalone and inside
  **Morpheus**, our Open WebUI fork in a separate repository.
- **Iris** (`apps/iris`, built): drives the real Claude Code and Codex through
  the gateway and checks what the ledger stored.

Native local operation (separate Node processes plus a local PostgreSQL)
works today, with no Docker. Docker Compose and cloud deployment are planned.
Delivery to the ledger is best effort: pending recordings are held in a
bounded in-memory queue and can be lost on a gateway restart. Recording never
delays the response to the harness. See
[ADR 0007](docs/adr/0007-ledger-service-and-postgres.md).

## Quick start

Requires Node 24+, pnpm, and PostgreSQL (see
[apps/ledger/README.md](apps/ledger/README.md) for native setup).

```bash
pnpm install
pnpm test

# The ledger service stores calls; the gateway sends them with this token.
export SEEIT_LEDGER_WRITE_TOKEN="$(openssl rand -hex 32)"
SEEIT_LEDGER_DATABASE_URL=postgresql://127.0.0.1:5432/seeit_ledger pnpm --filter @seeit/ledger start   # http://127.0.0.1:8788

# In another terminal, with the same SEEIT_LEDGER_WRITE_TOKEN:
SEEIT_LEDGER_URL=http://127.0.0.1:8788 pnpm dev   # gateway on http://127.0.0.1:8787
```

Without `SEEIT_LEDGER_URL` and `SEEIT_LEDGER_WRITE_TOKEN` the gateway still
forwards traffic, but records nothing.

Every recorded call belongs to a seeit user, `SEEIT_USER_ID` (default
`local`). There is no sign-in yet: the ledger trusts the value the gateway
sends (ADR 0009).

Send a harness through it (in another terminal):

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787/claude claude
```

For Codex, see [docs/phase-0-recorder.md](docs/phase-0-recorder.md).

Every call becomes one row in the ledger's PostgreSQL database, with tokens,
timings, turn, completion status, and plan-quota headers. Request and response
bodies are stored gzipped and kept; requests are stored as pieces, so text
that repeats within a session is stored once (ADR 0009). The ledger prints one line per stored
call. For example, recent calls:

```bash
psql -h 127.0.0.1 seeit_ledger -c "select started_at, harness, kind, completion, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens from calls order by started_at desc limit 20"
```

Calls recorded before the PostgreSQL ledger (the SQLite file `data/seeit.db`)
are not imported; that file is no longer read or written.

Raw JSON recordings of each call are also written to `data/recordings/`
(git-ignored).

## Layout

```
apps/gateway     Hono proxy server (TypeScript, Node 24)
apps/ledger      ledger service: recording ingestion, analysis, PostgreSQL storage
apps/iris        live harness runs through the gateway, checked against the ledger
apps/dashboard   planned: Vite + React dashboard
packages/core    shared parsers and helpers
docs/            plan, ADRs, phase notes
data/            local recordings and databases (git-ignored)
```

## For coding agents

Rules for agents working in this repo are in [AGENTS.md](AGENTS.md). Claude
Code reads them through [CLAUDE.md](CLAUDE.md).
