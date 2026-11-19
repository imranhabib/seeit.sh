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
| 1 | Stream parsing, usage, sessions and turns, SQLite ledger | ✅ done (cost estimates move to Phase 2) |
| 1C | Separate ledger service, PostgreSQL, background HTTP delivery, native/Docker local operation | next |
| 2 | Observability: Langfuse traces, custom dashboard | planned |
| 3 | Budgets and blocking, repo attribution | planned |
| 4 | Transforms, model router | planned |

The full plan is in [docs/PLAN.md](docs/PLAN.md), and the key decisions are in
[docs/adr/](docs/adr/).

## Next architecture

The next milestone separates the gateway from storage and dashboard work.
Gateway, ledger, and dashboard stay in this monorepo, with gateway and ledger
running as separate services. The gateway and ledger parts are built: the
gateway sends every call to the ledger service, which stores it in PostgreSQL.
The dashboard is next.

```text
Claude Code / Codex ──▶ Gateway ──▶ Model provider
                          │
                          │ background HTTP recording
                          ▼
                      Ledger service ──▶ PostgreSQL
                          ▲
                          │ read-only HTTP access
                   Dashboard / CLI
```

- **Gateway:** forwards raw traffic and streams provider responses immediately.
  It scrubs credentials from recording copies before writing locally or sending
  them to the ledger. Forwarded harness credentials remain unchanged.
- **Ledger:** owns recording ingestion, PostgreSQL access, migrations, retention,
  analysis, and read APIs. The gateway will have no PostgreSQL credentials.
- **Dashboard:** explains session token accumulation, context composition,
  cache behavior, and quota. It will work standalone and inside **Morpheus**,
  our Open WebUI fork in a separate repository. Langfuse remains the planned
  tool for general trace browsing.

PostgreSQL is owned by the ledger service but runs as its own process or
container. Planned runtime modes are:

| Mode | Setup |
| --- | --- |
| Native local | Separate gateway and ledger Node processes plus locally installed PostgreSQL. Docker is not required. |
| Docker local | Compose starts separate gateway, ledger, and PostgreSQL containers, with persistent database storage. |
| Cloud | Gateway and ledger deploy to separate instances using private service addresses; PostgreSQL runs separately from the ledger process. |

All modes use the same authenticated HTTP contract and recording-delivery
rules. Recording never waits for the ledger on the provider-streaming path.
V1 uses bounded in-memory pending recordings and retries; pending recordings
can be lost on restart, retry exhaustion, or queue saturation. A durable local
outbox and restart replay are deferred to v2. PostgreSQL persistence does not
protect a recording that has not reached the ledger yet.

Harnesses continue to point their base URL at the gateway. Docker and cloud
deployment change service addresses, not this interface. Native local startup
and Docker will use the same application entry points.

See [ADR 0007](docs/adr/0007-ledger-service-and-postgres.md) for the decision and
[the delivery sequence](docs/PLAN.md#phase-1c--ledger-service-and-delivery-next)
for the small PRs that implement it. Each PR includes a testing and code
walkthrough before the next slice starts. Native PostgreSQL and ledger startup
are documented in [apps/ledger/README.md](apps/ledger/README.md).
Read APIs and Docker startup remain planned.

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

Send a harness through it (in another terminal):

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787/claude claude
```

For Codex, see [docs/phase-0-recorder.md](docs/phase-0-recorder.md).

Every call becomes one row in the ledger's PostgreSQL database, with tokens,
timings, turn, completion status, and plan-quota headers. Request and response
bodies are stored gzipped for 14 days. The ledger prints one line per stored
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
apps/dashboard   planned: Vite + React dashboard
packages/core    shared parsers and helpers
docs/            plan, ADRs, phase notes
data/            local recordings and databases (git-ignored)
```

## For coding agents

Rules for agents working in this repo are in [AGENTS.md](AGENTS.md). Claude
Code reads them through [CLAUDE.md](CLAUDE.md).
