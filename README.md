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
| 2 | Observability: Langfuse traces, custom dashboard | planned |
| 3 | Budgets and blocking, repo attribution | planned |
| 4 | Transforms, model router | planned |

The full plan is in [docs/PLAN.md](docs/PLAN.md), and the key decisions are in
[docs/adr/](docs/adr/).

## Quick start

Requires Node 24+ and pnpm.

```bash
pnpm install
pnpm test
pnpm dev        # gateway on http://127.0.0.1:8787
```

Send a harness through it (in another terminal):

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787/claude claude
```

For Codex, see [docs/phase-0-recorder.md](docs/phase-0-recorder.md).

Every call becomes one row in the SQLite ledger at `data/seeit.db`, with
tokens, timings, turn, and completion status. Request and response bodies are
stored gzipped for 14 days. The gateway also prints one line per call. For
example, recent calls:

```bash
sqlite3 -header -column data/seeit.db "select started_at, harness, kind, completion, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens from calls order by started_at desc limit 20"
```

Raw JSON recordings of each call are also written to `data/recordings/`
(git-ignored). Summarize them with `pnpm summarize`.

## Layout

```
apps/gateway     Hono proxy server (TypeScript, Node 24)
packages/core    shared parsers and helpers
docs/            plan, ADRs, phase notes
data/            local recordings and databases (git-ignored)
```

## For coding agents

Rules for agents working in this repo are in [AGENTS.md](AGENTS.md). Claude
Code reads them through [CLAUDE.md](CLAUDE.md).
