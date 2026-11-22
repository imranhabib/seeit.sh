# seeit.sh — Plan

A single-user, local-first AI gateway that sits between coding harnesses
(Claude Code, Codex) and their model providers. It answers one question:
**where do my tokens go, and why?**

The project is also a learning project. The goal is to understand how data
flows through an LLM gateway, its major parts, and the code paths that are
critical for performance.

## Status (2026-11-22)

**Built and on `main`:**

- The gateway (`apps/gateway`) forwards Claude Code and Codex traffic, streams
  every response unchanged, scrubs credentials from its recording copy, and
  sends each call to the ledger service in the background (bounded in-memory
  queue, retries, no durable outbox).
- The ledger service (`apps/ledger`) takes recorded calls over authenticated
  HTTP, runs `analyzeCall` from `@seeit/core`, and stores the result in
  PostgreSQL. Writes are idempotent by call ID.
- `@seeit/core` parses both providers: usage (unknown stays null), cache
  writes by lifetime, server tools, fallback, completion status, timings,
  drift and invariant flags, call kind, plan-quota headers.
- Iris (`apps/iris`) drives the real harnesses through the gateway and checks
  what the ledger stored: 18 headless scenarios, plus MCP, skills, plugins,
  and compaction for both harnesses.
- The ledger data model ([ADR 0009](adr/0009-ledger-data-model.md),
  migration `0002`): users, sessions, turns, requests stored as pieces, tool
  uses, quota windows, context parts, the Codex model catalog, and new call
  columns. Body retention is removed: everything is kept.
- The gateway's own SQLite ledger is removed. Old SQLite data was not
  imported (decided 2026-11-18).

**Open draft:** [PR #5](https://github.com/imranhabib/seeit.sh/pull/5), a read
API mounted in the gateway over SQLite. Do not merge it as is; it is input
for the ledger read API (next steps, step 2).

## Next steps

Do these in order. Each one is a separate PR. After each PR, stop for a
walkthrough of how to test it, the changed code, the reasons, and the known
limits.

1. **Turn assignment in the ledger** ([ADR 0008](adr/0008-turn-assignment-in-the-ledger.md)).
   Assign turns in the ledger: the explicit turn ID first (Codex `turn_id`;
   Claude Code `x-claude-code-prompt-id` with
   `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`), then inference in
   `(startedAt, seq)` order. Turn IDs are deterministic. Append in order;
   replay the session for a late call. Recompute turn-dependent flags and
   totals. Remove the gateway's turn tracker (`apps/gateway/src/turns.ts`).
   Fill the ADR 0008 session columns, which are empty today.
   **Check:** late, reordered, duplicated, and lost calls (synthetic sessions
   for both harnesses) give the expected turns; a recompute keeps unaffected
   turn IDs; the Iris turn scenarios give the same results as the gateway
   tracker did.
2. **Ledger read API.** Move PR #5's metadata selection, validation,
   pagination, errors, and tests into `apps/ledger`, over PostgreSQL, with
   the endpoints in *Ledger API* below. Then switch `apps/iris/src/results.ts`
   from direct PostgreSQL reads to this API.
   **Check:** filtering, null and estimate semantics, safe JSON errors,
   read/write authorization; dashboard reads never enter the gateway process.
3. **Docker local packaging.** Gateway and ledger images, Compose, health
   checks, configuration examples, a persistent PostgreSQL volume. Reuse the
   native entry points.
   **Check:** the same ingestion, read, and outage scenarios pass natively
   and with Compose; restarting or recreating services keeps committed data.
4. **Phase 2 dashboard**, stages 1–6 in *Implementation stages and completion
   checks* below. It starts with the Morpheus embedding proof.

Work that can run in parallel with the steps above:

- **Prices:** the pinned price file and estimated API-equivalent USD per call
  (see *Prices* and Phase 2).
- **Iris:** a `tmux` driver for interactive-only actions (Esc interrupt,
  Codex `/compact`); request-body redaction for fixtures and fixtures from a
  run; an `/iris` skill to run it on a new harness version.
- **Parser coverage:** steps 5 and 6 in *Parser coverage* below.
- **Hook events:** [ADR 0010](adr/0010-hook-events.md) is proposed and not
  filled in yet.

**Known gaps in the data model** (ADR 0009): tool durations are not read;
Codex sends an empty secondary quota window; `bodies.request_gz` is kept only
for rows stored before migration `0002`.

## Decisions in force

The ADRs in [docs/adr/](adr/) hold the full reasons. In short:

| Decision | Where |
| --- | --- |
| Base-URL reverse proxy; one path prefix per harness | ADR 0001 |
| TypeScript on Node 24 with Hono, no build step | ADR 0002 |
| A ledger for seeit's own analysis, Langfuse for general trace browsing | ADR 0003 (its SQLite choice is superseded by ADR 0007) |
| A stream is never cut off mid-way; budget checks happen before the request | ADR 0004 |
| Parser coverage: spec-derived tests, recorded fixtures, live drift detection | ADR 0005 |
| Separate gateway and ledger services; the ledger owns PostgreSQL | ADR 0007 |
| The ledger assigns turns (not built yet) | ADR 0008 |
| Ledger data model: users, sessions, turns, pieces, tool uses, quota, context parts | ADR 0009 |
| Parsing runs in the ledger; credential scrubbing stays in the gateway | *Service boundaries* below (2026-11-18) |
| V1 delivery is best effort; a durable outbox is v2 | *Recording delivery rules* below |
| No body retention: bodies and calls are kept | *Data model* below (2026-11-18) |
| Every call belongs to a seeit user (`SEEIT_USER_ID`, default `local`); no sign-in yet | ADR 0009 |
| Old SQLite data is not imported | 2026-11-18 |
| A subagent's calls belong to the user's turn that started it, with `agent_id` | *Iris findings*, finding 2 |
| The gateway is the source of truth; harness session files only add facts later | *Gateway compared with the harnesses' session files* |
| Dashboard: one read-only frontend, standalone and inside the Morpheus Open WebUI fork | *Frontend delivery plan* |

## Scope

- **Users:** one (the owner). The data model has users from the start
  (ADR 0009), but there are no multi-tenant features.
- **Harnesses in v1:** Claude Code and Codex.
- **Auth:** both harnesses use **subscription auth** (Claude Max/Pro OAuth,
  ChatGPT login). The gateway passes these credentials through unchanged.
  "Cost" is therefore always an **estimated API-equivalent cost**. The real
  limit is the plan quota.
- **Runs:** locally first as separate native processes or Docker containers;
  later as separate cloud services reached over Tailscale. Docker is optional
  for local operation, including PostgreSQL.
- **Frontend:** one read-only dashboard, available in a standalone desktop
  browser and through a new **seeit** sidebar group in an Open WebUI fork.
  Open WebUI is another way to view Claude Code and Codex traffic; recording
  Open WebUI's own conversations is outside this release.

## Architecture

```
 claude ──ANTHROPIC_BASE_URL──▶ ┌──────────────────────────────┐ ──▶ api.anthropic.com
                               │  gateway  /claude/*  /codex/* │
 codex ───provider base_url───▶ │                              │ ──▶ chatgpt.com/backend-api/codex
                               └──────┬───────────────────────┘
                                      │ tee / background recording
                                      ▼
                            HTTP ledger service ◀── dashboard / CLI
                                      │
                                      ▼
                                 PostgreSQL

                  OTel traces ──▶ Langfuse (general trace browsing)
```

The gateway, the ledger service, and PostgreSQL are built. The dashboard, the
CLI, the read API, Docker packaging, and Langfuse export are not built yet.

### Service boundaries and deployment modes

Keep gateway, ledger, and dashboard in this monorepo. Each server has its own
entry point, configuration, startup command, and deployment artifact.
Morpheus remains in its existing separate repository.

- **Gateway:** forwards raw provider traffic and collects recording data from
  its own stream branch. It sends recordings to the ledger over HTTP outside
  the client response path. Credential scrubbing stays here: sanitize the
  recording copy before any local write, log, or ledger transmission. Forward
  the original harness credentials and provider traffic unchanged. The gateway
  has no PostgreSQL connection or credentials.
- **Ledger service:** owns recording ingestion, all application database reads
  and writes, schema migrations, and derived analysis. The dashboard and CLI
  use its read endpoints. Write credentials belong to the gateway; browser
  clients have read access only. Parsing runs in the ledger (decided
  2026-11-18): the gateway sends a `RecordedCall` (redacted request and
  response, piece arrival times, gateway-only facts; `packages/core/src/call.ts`)
  and the ledger runs `analyzeCall`. Credential scrubbing stays in the
  gateway. The gateway keeps its turn tracker until ADR 0008 is implemented.
- **PostgreSQL:** the single ledger database. The ledger owns access, but
  PostgreSQL runs as a separate process/container. Its placement can change
  without changing the gateway-to-ledger contract.
- **Dashboard:** the same frontend serves standalone and Morpheus access.
  The ledger service can serve the built static frontend; development uses Vite.

| Mode | Gateway and ledger | PostgreSQL | Service addressing |
| --- | --- | --- | --- |
| Native local, no Docker (works today) | Separate Node processes on one machine. | Locally installed PostgreSQL with persistent data. | Loopback HTTP and a local database connection. |
| Docker local (next steps, step 3) | Separate gateway and ledger containers started with Compose. | Separate PostgreSQL container with a named persistent volume. | Compose service names; publish user-facing ports on host loopback. |
| Cloud (later) | Gateway and ledger containers on separate instances/deployment units. | Initially a separate container with persistent storage on the ledger instance; can move to a dedicated database service. | Configured private network addresses and authenticated service requests. |

Native local operation is a first-class supported mode: installation, database
creation, migrations, startup, tests, and shutdown must work with no Docker
commands or Docker daemon. Do not make package scripts wrap Compose as the only
way to run a service. Docker invokes the same application entry points, with
environment-specific addresses and credentials. Publish example configuration
and separate startup commands for both modes; distinguish non-watching startup
for real harness traffic from development watch commands.

The harness interface stays the same: Claude Code and Codex point at the
gateway base URL; the gateway calls the provider. For local containers, listen
on `0.0.0.0` inside the container and publish the gateway on host
`127.0.0.1:8787`. Container-to-container traffic uses service names, not host
loopback. Cloud harnesses use the private gateway URL.

Use Docker images for cloud gateway and ledger deployment and Compose for the
local container stack. Compose on one host does not provide cross-instance
scaling. Separate cloud deployments can receive independent resources;
horizontal gateway replicas also require coordinated future budget counters
before they are safe. Turn tracking does not need coordination once the ledger
assigns turns (ADR 0008). Do not introduce orchestration as part of the
frontend work.

PostgreSQL data must survive application/container restarts and replacement in
both local modes and the cloud. Document native data-directory ownership and
Docker volume lifecycle, including that deleting a volume deletes its data.
Persistence and backups are separate concerns. The ledger waits for database
readiness; a running container alone is not a readiness check.

### Recording delivery rules — identical in every mode

- The gateway never waits for ledger ingestion or a database acknowledgement
  before forwarding provider chunks or finishing the harness response.
  Ledger downtime must not turn recording into a new forwarding dependency.
- Send each call after collection finishes, including interrupted-call
  records, as one `RecordedCall`. Sending live recording streams is a
  separate decision.
- Generate a stable call ID before collection. Retrying a recording with that
  ID must not insert a second call, duplicate bodies, or double-count usage.
  Acknowledge successful ingestion only after its database transaction commits.
- Bound request timeouts, retries, and pending recording count/bytes. A slow
  ledger must not create unbounded memory use or backpressure on the client
  stream. Make delivery failures and queue saturation visible without logging
  credentials or captured content.
- Apply the same authentication, validation, idempotency, and retry behavior
  over loopback, Compose networking, and cloud networking. Change configuration
  between deployments, not delivery semantics.
- **V1 delivery is best effort:** bounded in-memory pending recordings and
  retries. There is no durable outbox or restart replay. Unacknowledged records
  can be lost on gateway restart, exhausted retries, or queue saturation; a
  record already committed by the ledger remains stored even if its
  acknowledgement was lost. Do not claim lossless delivery.
- **V2 follow-up:** reconsider a bounded durable outbox on gateway-local
  persistent storage after the v1 services and dashboard are complete. Its
  storage format, disk limits, overflow policy, retention, and restart replay
  are deferred decisions. Gateway credential scrubbing must precede any future
  outbox write. The debug recordings in `data/recordings/` are not a delivery
  outbox or replay mechanism.

### Interception

Base-URL reverse proxy (see [ADR 0001](adr/0001-base-url-reverse-proxy.md)).
Each harness gets its own path prefix. The prefix identifies the harness and
picks the upstream:

| Harness     | Harness setting                                   | Upstream                                |
| ----------- | ------------------------------------------------- | --------------------------------------- |
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787/claude` | `https://api.anthropic.com`             |
| Codex       | custom provider `base_url = ".../codex"`          | `https://chatgpt.com/backend-api/codex` |

### Hot path rules

These rules are the performance-critical part of the system:

1. **Stream, never buffer.** Each SSE chunk goes to the client as soon as it
   arrives from upstream.
2. **Tee the stream.** One branch goes to the client, one to the parser.
3. **Storage never blocks the response.** Writes happen after the response or
   through a queue.
4. **Budget checks use in-memory counters.** No database query per request.
5. **Reuse upstream connections** (keep-alive and pooling).
6. **Forward raw bytes.** Decode only the fields the gateway needs. Never
   re-encode a full request or response body.

### Data model

The tables are in [ADR 0009](adr/0009-ledger-data-model.md) and
`apps/ledger/src/db/schema.ts`.

- **Trace hierarchy:** User → Session → Turn → Call.
  - User: a seeit user (`users`), `'local'` by default, from the gateway's
    `SEEIT_USER_ID`. Sign-in and permissions come later.
  - Session: one `claude` / `codex` run.
  - Turn: one prompt the user types, plus every model call and tool loop until
    the final answer. Taken from the harness when it sends a turn ID (Codex
    `turn_id`; Claude Code `x-claude-code-prompt-id` with
    `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`). Otherwise inferred (best effort): a
    new turn starts when the last message is new user text, not a
    `tool_result`. Today the gateway's turn tracker assigns turns; ADR 0008
    moves this to the ledger, where recent turns can change when a late call
    arrives.
  - Call: one HTTP request to the model.
- **Call kind: not every call is a turn.** Harnesses also send background
  calls that the user did not trigger, for example Claude Code's
  `HEAD /api/hello` connectivity check and its `"quota"` probe (`max_tokens: 1`,
  sent at startup to read the plan-quota headers). These are labeled
  `background` so they do not count as turns or skew per-turn metrics. Their
  tokens still count toward totals and budgets.
- **PostgreSQL ledger** ([ADR 0007](adr/0007-ledger-service-and-postgres.md)): one
  row per call with harness, session, turn, model, input / output / cache-read /
  cache-write tokens, latency, and flags. It is the source of truth for
  budgets and the dashboard. Sessions, turns, tool uses (tools, MCP, skills,
  subagents, plugins), compaction detail, quota windows, and context parts are
  in ADR 0009; hook events are open in [ADR 0010](adr/0010-hook-events.md).
- **Timings per call** (milliseconds from when the gateway received the
  request, measured with the monotonic `performance.now()` clock):
  - `timeToResponseHeadersMs`: upstream status and headers arrived. Network,
    auth, and queueing. The ChatGPT backend sends headers only when the model
    is ready, so for Codex this already includes model time.
  - `timeToFirstChunkMs`: first body chunk arrived. Usually a metadata event
    (`message_start`), not answer text.
  - `timeToFirstTokenMs`: first model output arrived. It is the first delta
    that carries text the model wrote (answer text, thinking text, tool
    input), or the start of an output block that arrives whole
    (`redacted_thinking`). Empty deltas (the empty `input_json_delta` that
    opens every tool call, the empty `thinking_delta` with thinking
    `display: "omitted"`) and `signature_delta` do not count. For Codex, only
    deltas that carry model text count, not every `*.delta` (a server-run
    shell command's stdout arrives as
    `response.shell_call_output_content.delta`).
  - `timeToStreamEndMs`: stream ended.
  - Derived at query time, not stored: prefill time ≈ `timeToFirstTokenMs −
    timeToResponseHeadersMs`; output speed = `output_tokens ÷
    (timeToStreamEndMs − timeToFirstTokenMs)` tokens per second.
- **Completion status per call.** Decided from the **events**, not from how
  the connection ended (Codex closes the connection right after its final
  event, so a closed connection does not mean a truncated stream):

  | Status | Meaning | How it is detected |
  | --- | --- | --- |
  | `complete` | Final event seen | `message_stop` (Claude) / `response.completed` (Codex) |
  | `upstream_error` | Provider sent an error event mid-stream | `event: error` (for example `overloaded_error`) |
  | `client_aborted` | Harness closed first (Esc, Ctrl+C, harness timeout, crash) | The client request's abort signal fired before the final event |
  | `upstream_dropped` | Provider or network closed first | Reading from upstream failed (`ECONNRESET`) before the final event |
  | `gateway_error` | The gateway itself failed (bug, restart) | Exception in the gateway's stream path |

- **Truncated calls still cost tokens.** The provider bills the full input plus
  the output generated before the stop. For a Claude call without its final
  `message_delta`, input tokens come from `message_start` and output tokens are
  **estimated** from the text deltas received, marked as an estimate in the
  ledger. Otherwise interrupted calls would show zero output, and budgets would
  undercount.
- **Bodies:** full request and response bodies, gzipped. No retention:
  everything is kept (decided 2026-11-18; storing requests as pieces makes this
  affordable, about 0.2-0.5 GB per month at the owner's 2026-11-18 traffic).
  Requests are stored as pieces, each distinct piece once per user, harness,
  and session, and rebuilt from a recipe (ADR 0009).
- **Traces:** OpenTelemetry (GenAI semantic conventions) exported to a
  self-hosted Langfuse. Not built yet.
- **Prices:** a pinned copy of LiteLLM's `model_prices_and_context_window.json`
  plus local overrides. Never fetched at runtime. Cache-read and cache-write
  prices must be correct. Not built yet.

### Budgets

Phase 3; not built yet.

- Units: tokens and estimated USD. Plan-quota % later, if the quota headers are
  reliable.
- Scopes: global per day and per month, per harness. Per session later.
- Checked **only before a request is sent**. A stream is never cut off mid-way
  ([ADR 0004](adr/0004-no-mid-stream-cutoff.md)).
- A blocked request gets an error in the provider's own format (for example an
  Anthropic-style `429`) so the harness shows it correctly.
- **Gateway blocks are labeled.** Upstream also returns `429`s (for example on
  the startup quota probe), so the gateway adds its own header
  `x-seeit-blocked: budget` to every block it makes. The ledger stores who
  blocked the call (`upstream` or `gateway`), so the dashboard can tell
  "Anthropic said no" from "my budget said no."
- A warning is logged at 80%.

### Security

- Never store or log `Authorization`, cookies, or account-ID headers. Redact
  them in the gateway's recording copy before any write or transmission to the
  ledger. Use the redaction helper (`apps/gateway/src/redact.ts`) and extend it
  for credential-bearing fields in the ingestion contract; header redaction
  alone does not make arbitrary body content secret-free. Scrubbing must not
  change the request or response bytes forwarded between harness and provider.
- Bind to `127.0.0.1` locally.
- Server deployment: no public port. Reach it over Tailscale and require a
  gateway token in a custom header (`ANTHROPIC_CUSTOM_HEADERS` for Claude Code,
  `env_http_headers` for Codex).
- Stored bodies contain code and possibly secrets. Keep the database and
  `data/` on an encrypted disk.

### Operations

- Native local services can be managed with `launchd`; Docker deployments use
  separate containers. If the gateway is down, the harnesses fail
  (fail-closed). This is on purpose: budgets must not be easy to bypass.
- Emergency bypass: unset `ANTHROPIC_BASE_URL` / switch the Codex profile.
- A gateway restart cuts every stream in progress. In development, `pnpm dev`
  (`tsx watch`) restarts on every file save, so do not edit gateway code while
  a harness session you care about runs through it.
- On a server, any reverse proxy in front of the gateway must not close idle
  connections during long model pauses (for example nginx closes after 60 s of
  no data by default). Raise its read timeout and turn off response buffering.

### CLI

Not built yet. A `seeit` command for running and inspecting the gateway from a
terminal. The dashboard is for browsing and charts; the CLI is for quick
answers and scripting.

**Naming rule.** Commands follow the data model (Session → Turn → Call). A
plural noun lists (`calls`), a singular noun shows one (`call <id>`).

| Command | What it answers | Phase |
| --- | --- | --- |
| `seeit start` | Run the gateway (later: as the `launchd` service) | after the read API |
| `seeit status` | Is the gateway up, is the ledger reachable, is each harness pointed at it | after the read API |
| `seeit setup claude\|codex` | Print the base-URL settings for a harness | after the read API |
| `seeit sessions [--harness --since]` | Recent sessions | after the read API |
| `seeit session <id>` | Turn → call tree with tokens, cache, flags (subagents with F) | after the read API, then 3 |
| `seeit calls [--session --kind --flagged]` | Recent calls | after the read API |
| `seeit call <id> [--request --response]` | Timings, usage, completion, flags; stored bodies for debugging (context breakdown with A) | after the read API, then 2 |
| `seeit drift` | Unknown event types, usage fields, and invariant flags per harness version | after the read API |
| `seeit fixture <call-id\|session-id> -o <file>` | Redacted test fixture from the ledger | parser coverage step 5 |
| `seeit usage [--by day\|harness\|model] [--since]` | Tokens and estimated USD | 2 |
| `seeit quota` | Plan-quota use and forecast (C) | 2 |
| `seeit prices update` | Refresh the pinned price file on purpose (never at runtime) | 2 |
| `seeit budget [set ...]` | Show or set budgets, and what was blocked | 3 |

**Terms.**

- A *call* is one HTTP request to the model, not a turn. One turn usually has
  several calls (each tool loop is a new call), and background calls belong to
  no turn.
- A *fixture* is test input: a response stream (or, for a scenario, a
  session's request/response pairs) that is redacted and reviewed by hand
  before it is committed. `seeit call <id> --response` shows the stored
  response for debugging and is **not** redacted for the repo. The two are
  separate commands so debug output is not committed by mistake.

**Decisions.**

- **The CLI and dashboard read through the ledger service's HTTP API.** They
  do not open the database or route reads through the gateway (ADR 0007).
- **No raw SQL command.** Do not add a raw SQL HTTP endpoint or give the CLI
  PostgreSQL credentials. Use `psql` directly for ad-hoc queries.
- **`seeit fixture` keeps the hand review.** It writes to a file and prints a
  reminder that the repo is public; it never writes into the test folders
  itself.
- **No new dependency for argument parsing.** Use Node's built-in
  `util.parseArgs`.
- **Developer tasks stay in the `justfile`** (`just reset-recordings`, `just test`). The
  CLI is for operating and inspecting the gateway, not for working on its
  code.
- **Build order:** `calls`, `call`, `sessions`, `session` first. The rest
  arrive with the phase that adds their data.

## Stack

TypeScript on Node 24 LTS with Hono ([ADR 0002](adr/0002-typescript-node-hono.md)).

```
apps/gateway       Hono proxy server (built)
apps/ledger        HTTP service; owns PostgreSQL storage and the write API (built), read API (next)
apps/iris          drives the real harnesses through the gateway and checks the ledger (built)
apps/dashboard     Vite + React dashboard (Phase 2)
apps/cli           `seeit` command (see *CLI*)
packages/core      shared parsers and analysis, imported as @seeit/core (built)
packages/contracts shared ledger HTTP request/response contracts, when needed
infra/             Dockerfiles, Compose, deployment docs (next steps, step 3)
docs/              this plan, ADRs
```

PostgreSQL through the `pg` driver with Drizzle, owned by `apps/ledger`.
Migrations are generated by drizzle-kit into `apps/ledger/drizzle/`. Tests use
Vitest; the ledger's PostgreSQL tests run against a configured native
PostgreSQL instance without Docker (`SEEIT_TEST_DATABASE_URL`).

## Differentiators

What existing tools (LiteLLM, Portkey, Helicone, Langfuse, `ccusage`, the
harnesses' own OTel export) do not do: understand the *contents* of agent
traffic.

| ID | Feature                         | Phase   |
| -- | ------------------------------- | ------- |
| A  | Context composition breakdown   | 2       |
| B  | Cache-break detector            | 2       |
| I  | Prompt cache and compaction explainer (key feature) | 2 |
| C  | Plan-quota forecast             | 2       |
| D  | Repo / branch attribution       | 3       |
| E  | Waste detection                 | 2       |
| F  | Subagent tree                   | 3       |
| G  | Soft budget actions (downgrade) | 4       |
| H  | Session diff replay             | stretch |

## Phases

| Phase | What | State |
| --- | --- | --- |
| 0 | Recorder spike ([phase-0-recorder.md](phase-0-recorder.md)) | done |
| 1 | Stream parsing, usage, sessions and turns, completion, drift flags | done; cost moves to Phase 2 |
| 1C | Ledger service, PostgreSQL, gateway delivery, data model | ledger, ingestion, delivery, cutover, data model done; turn assignment, read API, Docker next |
| 2 | Observability: prices, dashboard (A, B, C, E, I), Langfuse | planned |
| 3 | Budgets and blocking, repo attribution, subagent tree | planned |
| 4 | Transforms, model router | planned |

### Phase 2 — Observability

- Pinned price file and estimated USD cost per call. Price 5-minute and
  1-hour cache writes separately (live-run finding 6). Price server tool use
  (`server_tool_use`, billed per search) and, after a server-side fallback,
  each attempt in `usage.iterations` at its own model's rates (calls flagged
  `fallback_usage_partial`).
- OTel export to Langfuse (Docker Compose).
- Dashboard: A, B, C, E, and I (the key feature, below).
- Optional session-file importer (see *Gateway compared with the harnesses'
  session files*): reads Claude Code `compactMetadata`, tool and thinking
  durations, and skill/plugin attribution, and Codex `content_token_count`,
  and adds them to existing calls by `provider_request_id`. Never creates
  calls; labels and numbers only. Each harness version's file format is
  checked with an Iris recording first, as for parsers (ADR 0005).
- Quota tracking (C) uses only responses that carry quota headers. Responses
  without them (for example an upstream `429` with no
  `anthropic-ratelimit-unified-*` headers) are skipped, not read as zero.

#### Feature I — Prompt cache and compaction explainer (key feature, agreed 2026-11-18)

**Job:** show how each harness uses the prompt cache and compaction: how it
is done, what is cached and what is not, and the tokens each one uses and
saves. It builds on A (composition) and B (cache breaks), and it is the main
content of the Cache page and of the session and call detail views. The
facts it relies on are in *Field inventory, prompt caching, and compaction*
below; the stored data is in ADR 0009 ("Context parts, caching, and
compaction detail").

**What the dashboard shows**

1. **Startup context.** For a session's first call, and for the first call
   of each context window after a compaction: the parts of the prompt by
   category (system prompt, tool definitions, deferred tools, global and
   project instructions, environment, skills, plugins, MCP, permissions and
   collaboration, multi-agent, hook output, compaction summary, the prompt),
   with tokens and characters per part. For each part: read from cache
   (including a cache that an earlier session wrote), written to cache, or
   uncached. Startup tokens = the first call's input minus the prompt.
2. **Cache map per call.** A bar in prefix order (Claude: tools → system →
   messages; Codex: input order) split into read, written, and uncached
   segments, by part. Claude: the breakpoints and their lifetime (5 minutes
   or 1 hour). Codex: the cache boundary, exact per item from attribution,
   in 128-token blocks. When the cache broke: the provider's reason
   (`cache_miss_reason`, field inventory 15) when it is sent, then the first
   changed part (B).
3. **Cache economics** per call, turn, and session: hit rate (cache reads ÷
   total input); tokens read, written (by lifetime: 5m / 1h for Claude,
   30m / 12h for Codex), and uncached; estimated API-equivalent savings
   (reads × (input price − cache-read price)) and the cost of writes,
   including the 1-hour premium. Savings are estimates, never subscription
   money.
4. **Cache lifetime.** The last hit and the expiry time of each prefix
   (Claude: 5 minutes or 1 hour after the last hit; Codex: the reported
   retention, `24h`). A gap longer than the lifetime followed by a rewrite
   is a finding, "cache expired while idle", with its cost. It is expected
   behavior; the finding shows what the pause cost.
5. **Compaction events.** Trigger (auto, manual, reactive), reason, phase,
   and strategy. The compaction call's cost (input read and uncached, output
   = the summary) and the summary's size. Context before (the last call
   before it) and after (the first call after it), tokens saved on each later
   call, and the number of calls until it paid off, or "did not pay off"
   (field inventory 13). The cache rewrite after it (Claude writes the whole
   new history again). With the session-file importer, Claude Code's own
   `preTokens` / `postTokens` and duration, including automatic compactions.
6. **Context window fill.** Input tokens of each call against the model's
   context window, and the automatic compaction threshold when it is known
   (Codex: catalog or the user's setting; Claude: shown as unknown).
7. **Other context mechanisms.** Claude context editing (`applied_edits`:
   what the API removed); Codex tool-output truncation (the catalog's
   `truncation_policy`); reasoning sent again on every Codex call (its tokens
   and cached share); subagent prefixes (Claude subagents use 5-minute
   breakpoints; Codex `warm_fork` starts from the parent's history).

**Rules**

- Every token number says where it comes from: `provider` (Codex
  attribution, usage totals), `breakpoint` (exact, from a Claude cache read
  that ends at a breakpoint), or `estimated` (characters × a ratio per
  provider and kind of content). Claude parts show an unallocated difference
  against the reported total; they are never forced to add up.
- Show each harness's own mechanism. Claude: explicit breakpoints and
  lifetimes. Codex: automatic prefix caching by `prompt_cache_key`. Do not
  explain one with the other's rules.
- "Saved" can be negative. Show the measured before and after, not an
  expected saving.
- A compaction is shown only from evidence: the harness says so (Codex
  turn metadata; Claude hint headers). A size drop alone is a possible
  compaction.
- Labels are safe: categories, tool and skill names, and the kind of
  instruction file (global, project, local). Never file paths or content.

**Where it appears:** Cache page (economics, lifetime, breaks, compactions
across sessions); session detail (startup context, cache economics,
compaction events on the timeline, window fill); call detail (cache map and
parts). API: `/api/cache` and `/api/calls/:id` carry it.

#### Frontend delivery plan — agreed 2026-11-16

**Primary job:** answer “Why did this session use so many tokens?” Start with
an overview, find a session, inspect its accumulation over time, and expand
the turns and calls that explain it. Quota is supporting information.

**Delivery boundary:** build the dashboard plus the read API, derived
analysis, and storage needed to supply it. Make the Open WebUI changes in the
existing local fork, **morpheus**, a sibling checkout of this repository
(`../morpheus`). Keep the PostgreSQL ledger, owned by the ledger service, as
the source of truth. Langfuse continues to handle general trace browsing under
ADR 0003; seeit provides enough session, turn, call, and request-excerpt
detail to complete a token investigation without leaving the dashboard. Full
conversation replay remains outside this release. Langfuse availability must
not block seeit.

##### Pages and navigation

The Open WebUI sidebar has one **seeit** group with four links. The standalone
dashboard exposes the same destinations and direct URLs. Proposed routes:

| Page | Route | Content and main action |
| --- | --- | --- |
| Overview | `/overview` | Usage over time, quota summary, recent sessions, and evidence-backed findings; open a session or finding. |
| Sessions | `/sessions` | Searchable, filtered session list; open a session's accumulation and call detail. |
| Cache | `/cache` | Cache economics, lifetimes, reuse and break findings, and compaction events (feature I); compare requests and inspect the first changed prefix. |
| Quota | `/quota` | Reported windows, usage, resets, observation age, and qualified forecasts. |

Session detail uses `/sessions/:sessionId` and call detail `/calls/:callId`.
Include the harness in identity and API lookup where needed to avoid merging
unrelated sessions with the same ID. Calls without session IDs remain
inspectable and count in overall usage; never invent a session for them.

Use time range, harness, and model filters where meaningful. Sessions also
support finding/status filters and search by session ID or available label.
Keep applicable filters in the URL so refresh, back navigation, and copied
links preserve the investigation. Implementation defaults: Overview starts
with the last 24 hours and both harnesses; lists start with the newest records.
Do not apply a time filter to silently truncate the full history of a selected
session. Paginate lists and fetch large detail views separately.

Session detail contains:

- A summary with usage, estimated API-equivalent cost when available, call
  count, completion states, and data-quality information.
- A cumulative token chart across calls, split into uncached input, cache
  reads, cache writes, and output. Include background token use where linked;
  keep background calls separate from user turns. Connectivity checks are
  visible as diagnostics and do not inflate turn counts.
- A per-call input chart showing tools, instructions, conversation content,
  and unattributed content. This shows input size, not cumulative consumption.
- An aligned event timeline for tool calls/results, cache changes, and
  confirmed or inferred compaction. Selecting an event opens its call and
  evidence. A size drop alone is only a possible compaction.
- Expandable turn → call rows. Call detail shows usage, completion, model,
  harness version, timings, category contributors, findings, and source
  excerpts.

##### Accounting and evidence rules

- Total input = uncached input + cache reads + cache writes. Reasoning tokens
  are already part of output; show them as a subset, never add them again.
  Cumulative usage measures tokens processed across requests, including
  repeated context. It is not the number of unique tokens in a session.
- Keep provider-reported usage separate from estimated composition. Categories
  and contributors need a documented counting method, analysis version, and
  confidence/source. Never present character counts as exact token counts or
  silently force estimated slices to equal a reported total. Show an
  unallocated difference when meaningful; otherwise show composition estimates
  separately from the authoritative total.
- Distinguish tool definitions (input), tool-call arguments (output), and tool
  results included in later input. Attribute results to tool calls when IDs
  permit it. Show each result's estimated size and its repeated contribution
  to subsequent calls. These are separate measures and must not be summed as
  extra usage on top of the call totals. Preserve unattributed content.
- Expand category contributors to inspect individual tools, instruction
  blocks, messages, and tool results. Attribute files, skills, and MCP servers
  only when the captured request supports it. Do not infer precise ownership
  from merged text or assign an entire model call's cost to one invoked tool.
- Unknown usage stays unknown. Aggregates with missing contributions show
  partial coverage, rather than presenting the known sum as complete. Label
  estimates and parsing flags at call level and in affected aggregates.
- Cache analysis compares compatible setups, including across sessions, since
  the cache outlives a session. For Claude, compare the tools → system →
  messages prefix against actual cache breakpoints. Name the comparison call,
  first changed item, breakpoint, and observed reads/writes. Exclude metadata
  that does not form part of the cached prompt. Distinguish expected git or
  configuration changes from potentially avoidable changes. Do not assume
  every zero-read call is a miss or every new write is preventable.
- Provider support may differ. Unsupported cache explanations or compaction
  signals must show their limitation; do not apply Claude's cache rules to
  Codex. Inferred events carry their evidence and uncertainty.
- Waste findings identify measurable patterns: large definitions, repeated
  large results, potentially avoidable cache breaks, and interrupted calls
  with usage. Rank by observed contribution where comparable; show the
  evidence and affected calls. No universal waste score or unsupported claim
  of recoverable savings. Size alone does not establish waste.
- Cost always means estimated API-equivalent USD, never subscription spend.
  Unknown models or missing pricing inputs produce unavailable/partial
  estimates, never an apparent zero cost.
- Label timings according to the events actually measured. Prefill is
  approximate; Codex response-header time already includes model time. Omit
  derived rates when their inputs are missing or invalid.

##### Quota behavior

Normalize each supported provider window without losing its source snapshot
(`quota_windows`, ADR 0009). Show reported usage, reset time, and observation
time. Missing quota headers do not reset usage to zero; retain and age the
last valid observation. Quota may include account activity outside this
gateway, so do not attribute every quota change to a recorded session.

Forecast from comparable observations within the same window/reset period.
Never combine unrelated limits, cross a reset, or convert API-equivalent USD
into quota. Show the sample interval and “at your recent usage rate.” With
insufficient or stale observations, show the last known state and explain
that a forecast is unavailable. Define minimum sample coverage and freshness
rules with documented provider examples during implementation; test resets,
missing headers, flat usage, and decreasing/corrected observations.

##### Derived analysis and ledger API

Persist compact, versioned derived measurements and findings independently of
raw bodies (`context_parts` carries an analysis version). Retain
category/contributor measurements, safe tool labels, relationships, and
event/finding metadata with call history. There is no body retention (decided
2026-11-18). If retention returns, raw content, excerpts, diffs, and copied
source text must follow it; do not retain them indirectly in finding payloads,
and older investigations keep charts and derived totals and show when source
evidence has expired. Record analysis failures and coverage gaps.

Analyze new calls in the ledger service at ingestion. Keep expensive analysis
bounded so it does not starve recording writes or dashboard reads. Support an
explicit, bounded backfill from stored bodies when the analysis version
changes. Older rows without analysis show “analysis unavailable.” GET
requests read stored results; they must not trigger unbounded body scans or
recompute the full ledger on each refresh.

Use the ledger service's read API for both dashboard and CLI, under ADR 0007.
Keep the authenticated gateway-ingestion contract separate from browser read
access. Start with plain typed responses and these read endpoints:

| Endpoint family | Responsibility |
| --- | --- |
| `/api/overview` | Filtered aggregates, coverage, recent sessions, and findings. |
| `/api/sessions` | Paginated sessions and summary metadata. |
| `/api/sessions/:id` | Harness-qualified session totals and charts; paginated turns/calls as needed. |
| `/api/calls` | Bounded call metadata list with filters and pagination. |
| `/api/calls/:id` | Call metadata, composition, tool contributions, and findings. |
| `/api/calls/:id/evidence` | Bounded, on-demand excerpts/diffs; explicit unavailable state. |
| `/api/cache` | Filtered, paginated cache comparisons and findings. |
| `/api/quota` | Latest normalized windows, observations, and qualified forecasts. |

Specify query parameters, pagination, null/estimate semantics, and error
responses before wiring screens. No raw SQL endpoint. Do not expose stored
headers or secrets through summary payloads. Request content remains sensitive
and is loaded only when the user opens detail. Keep services loopback-bound
by default and verify how the local browser runtime reaches them.

##### Frontend behavior and Open WebUI integration

- Use a Vite + React app in `apps/dashboard`. Keep frontend code outside
  gateway watch paths so UI edits do not restart active streams. Use a
  development proxy for `/api`; prefer one origin for the installed dashboard
  and ledger API to simplify standalone and embedded access. Keep dashboard
  reads out of the gateway process and support direct page reloads.
- Use a compact, table-led desktop layout, dark by default, with clear
  typography and restrained composition/time charts. Smaller windows remain
  usable. Use keyboard-accessible controls, visible focus, chart legends,
  and equivalent numeric detail; do not convey state through color alone.
- Poll completed-call data on a modest interval, pause polling in hidden
  views, and preserve filters, selection, and scroll position. Show the last
  successful update and connection state. Keep existing data visible with a
  stale indicator on failure. No live stream token counters in this release.
- Distinguish loading, no recorded traffic, no filter matches, partial or
  unsupported analysis, and API failure. An empty chart must not imply
  measured zero usage.
- Use the existing **morpheus** Open WebUI fork. Add **seeit** using the
  existing sidebar group components and wire Overview, Sessions, Cache, and
  Quota links to browser tabs displaying the same frontend URLs. Reuse/focus
  an existing destination tab rather than creating duplicates. Tabs remain
  available across chat switches and do not create artificial conversations.
- Upstream browser tabs currently belong to chat workspaces. Persistent seeit
  tabs therefore need an explicit application-level workspace in the fork;
  preserve ordinary chat tab behavior. Reuse browser rendering rather than
  copying the React dashboard into Open WebUI's Svelte frontend.
- Pin the fork's upstream revision and document its maintenance patch. Verify
  Proxy/Chrome browser mode compatibility and required Open Terminal support
  against that revision. Choose the smallest supported rendering path after
  a real integration check; do not assume iframe cookies, same-origin access,
  or container access to host loopback will work automatically. Failure to
  connect should show a useful error and the standalone URL.
- First deployment is local, with Open WebUI, its browser runtime, and seeit
  on the same host. Verify both native processes with native PostgreSQL and the
  container stack. Test reachability from the actual browser runtime.
  Remote/Tailscale deployment to separate instances is a later milestone.

Upstream integration references, checked 2026-11-16:
[v0.13.0 release notes](https://github.com/open-webui/open-webui/releases/tag/v0.13.0),
[browser tab workspace](https://github.com/open-webui/open-webui/blob/main/src/lib/components/chat/ChatTabs.svelte),
[browser renderer](https://github.com/open-webui/open-webui/blob/main/src/lib/components/chat/ChatTabs/Browser.svelte),
and [sidebar](https://github.com/open-webui/open-webui/blob/main/src/lib/components/layout/Sidebar.svelte).
The `main` links are discovery references; pin implementation references to
the selected fork revision.

##### Implementation stages and completion checks

Each stage can contain several small PRs. After each PR, stop for a walkthrough
of how to test it, the changed code, and the reason for the change. Keep
deployment tooling and UI slices separately reviewable. The full release
includes A, B, C, E, and I plus both frontend access modes; early stages do
not substitute for completion.

The stages use the ledger read API (next steps, step 2). Synthetic data can
support early visual review, and a small Morpheus embedding proof should
happen early to expose browser/network constraints before the full dashboard
is built.

1. **Confirm data contracts and the embedding path.** Identify remaining
   usage/pricing gaps, and extend the ledger contracts with synthetic
   examples. In the **morpheus** Open WebUI fork, prove a sidebar link can
   open a local page through the selected browser mode and persist across
   chat switches. Verify a prototype can fetch its API. Record the pinned
   revision and local network setup.
   **Check:** no dependency on chat creation, no duplicate destination tabs,
   and a documented contract for unknown and partial data.
2. **Deliver the first usable investigation.** Add the dashboard shell,
   Overview, Sessions, direct call routes, and read endpoints over existing
   ledger fields. Add cumulative usage and turn/call tables, filtering,
   pagination, and completed-call refresh. Prepare representative screen
   states with synthetic data for visual review before expanding the charts.
   **Check:** ledger totals reconcile across pages; calls without sessions
   remain visible; refresh and browser navigation preserve the investigation.
3. **Add composition and session events (A).** Build on the stored
   `context_parts` and `tool_uses` (ADR 0009) for categories, tool
   definitions/arguments/results, repeated input, and evidence-backed
   compaction events. Complete the per-call charts, contributor expansion,
   timeline, and evidence views. Include feature I's startup context and
   per-call cache map.
   **Check:** both harness formats are covered; missing identity stays
   unattributed; estimates do not masquerade as reported totals; Codex parts
   match attribution by item ID; a Claude tools + system anchor equals the
   cache read that ends at `system[2]`.
4. **Explain cache behavior and surface findings (B, E).** Implement
   compatible-request selection, supported prefix/breakpoint comparison, and
   expected-versus-potentially-avoidable findings. Complete Cache and findings
   on Overview/session pages. Add API-equivalent pricing once the pinned
   prices are ready. Complete feature I: cache economics, cache lifetime and
   idle expiry, compaction events with before/after and break-even, context
   window fill, and the other context mechanisms.
   **Check:** the worked examples in live-run finding 4 distinguish a
   tool-definition break from an expected git-snapshot break; cross-session
   reuse is handled; unsupported explanations and missing prices remain
   explicit; the Iris compaction recordings (field inventory 11–13) give the
   expected before, after, and cost, including a compaction that did not pay
   off.
5. **Complete Quota (C).** Show freshness and reset windows from
   `quota_windows`, and add qualified forecasts with documented evidence
   requirements.
   **Check:** missing headers preserve the last observation, resets do not
   create false rates, and sparse/stale data produces no confident forecast.
6. **Complete integration and release verification.** Finish all four sidebar
   links and the persistent seeit workspace. Verify standalone deep links and
   the actual local Open WebUI browser path. Check narrow layouts, keyboard
   use, API outages/recovery, and large paginated sessions.
   **Check:** one frontend serves both access modes, tabs survive chat changes,
   and gateway streaming behavior remains intact.

Use meaningful unit tests for accounting, attribution, cache comparisons, and
forecasts; API tests for filtering/pagination and data states; and browser
checks for the investigation flow in both access modes. Follow ADR 0005 for
provider examples and reviewed fixtures. Run `pnpm typecheck` and `pnpm test`
for implementation changes, including the streaming integration test when
touching the proxy path. Ledger tests accept a configured PostgreSQL
connection so they work with native or container databases. Verify the proxy
under concurrent recording and dashboard load; an isolated streaming test
alone does not show that background work cannot delay the hot path.

New runtime dependencies still require approval under the repo rules. Choose
the minimum frontend dependencies needed for the agreed Vite + React stack;
do not add a chart framework, state framework, or component suite by default.

**Outside this release:** Open WebUI conversation ingestion, budget editing
or enforcement, routing controls, retention settings, repo/branch attribution,
subagent trees, full replay, mobile-specific workflows, live token counters,
and remote deployment. These remain in their later phases where applicable.
The delivered dashboard interface is read-only; the ledger service also
exposes authenticated recording ingestion to the gateway.

### Phase 3 — Budgets and attribution

- Budgets and blocking (rules above), including the `x-seeit-blocked` label.
- D (repo / branch attribution), F (subagent tree).

### Phase 4 — Transforms and routing

- Request transforms as middleware (for example Headroom).
- Same-provider model router. Subscription tokens never go to another
  provider. Cross-provider routing only for API-key traffic added later.
- G (soft budget actions). Stretch: H.

## Testing

- Recorded, redacted SSE streams are fixtures for parser, usage, turn
  detection, and context breakdown tests.
- One streaming integration test: a slow fake upstream, and an assertion that
  the first chunk reaches the client before upstream finishes.
- Iris scenarios for live checks; run only the scenarios a change affects
  (AGENTS.md).

## Harness findings and parser rules (reference)

What the harnesses were seen to send, and the parser rules decided from it.
Code and tests refer to these items by name and number ("streaming gap 4",
"follow-up step 1", "live-run finding 1", "Iris finding 2", "field inventory
1"), so keep the numbers when you edit this section.

### Version-tolerant parsing

Harnesses change their request format between versions without notice.
Example (Codex 0.153.4 → 0.169.0): tools moved from the top-level `tools`
field to an `additional_tools` item in `input`, and the system prompt moved
from `instructions` to `developer` messages in `input`. The parser:

- looks for tools and instructions in **both** places;
- treats Codex's usage `attribution` as **optional**, so composition needs a
  token estimate as a fallback for Codex too, not only for Claude;
- stores the harness version (from `user-agent`) on every call, so a parser
  failure can be traced to a specific version;
- keeps one recorded fixture per harness version it supports.

### Streaming gaps (Anthropic's streaming spec)

Found by reading [Anthropic's streaming
docs](https://platform.claude.com/docs/en/build-with-claude/streaming). All
five are handled.

1. **The model can change mid-stream (server-side fallback).** The serving
   model comes from the `fallback` block's `to.model` and from the
   `fallback_message` entry in the final `message_delta`'s `usage.iterations`
   ([refusals and fallback
   docs](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback)).
   After a fallback, the top-level `usage` counts only the serving model;
   earlier attempts are listed only in `usage.iterations`. Such calls are
   flagged `fallback_usage_partial` until Phase 2 prices each attempt.
2. **Server tools change input tokens mid-stream** (search results become
   input). Server tool counts are stored; input on a cut stream with server
   tool use is marked estimated.
3. **Some blocks arrive whole, with no deltas**: `redacted_thinking`, server
   tool results such as `web_search_tool_result`, and `fallback`. Their
   `content_block_start` content counts for the output estimate and
   `timeToFirstTokenMs`.
4. **An empty thinking delta is not the first token.** With thinking
   `display: "omitted"`, the stream sends a `thinking_delta` with an empty
   string, then a `signature_delta` (see *Timings per call*).
5. **Stream recovery stays in the turn.** See Iris finding 5.

### Parser coverage ([ADR 0005](adr/0005-parser-coverage-strategy.md))

1. **Live drift detection (layer 3). Done.** Unknown event types and usage
   fields are counted per harness version and stored on the call. Invariant
   violations are stored as flags: `complete` but no usage; `turn` without a
   turn ID; a model change with no `fallback` block; input tokens that change
   with no server tool use; estimated tokens on a `complete` call. The first
   call from a harness version without fixtures is flagged
   `untested_harness_version`. Connectivity checks are their own kind with no
   failure status. `harness_version` comes only from the harness's own
   user-agent (`claude-cli/…`, `codex_exec/…`), never a runtime's (`Bun/…`).
   Tool count and size are stored per call. Codex per-limit quota, credit, and
   window headers (`codex-rs/codex-api/src/rate_limits.rs`) are read.
2. **Spec-derived tests (layer 1). Done.** For the streaming gaps, several
   `message_delta` events, and mid-stream errors. Each test links its source.
3. **Typed field access. Done.** Provider SDKs are dev dependencies, for types
   only. Parsing is fail-soft: every field is optional, and a missing usage
   field stays **unknown (null)**, not 0. Cache writes are stored split by
   lifetime (5-minute and 1-hour) with the total.
4. **Scenario recordings with Iris (layer 2). Partly done.** `apps/iris`
   (`pnpm iris run`) records the harnesses through the real gateway, so it
   can be repeated on a new harness version. Decisions:
   - **Black box.** Iris starts the gateway's real entry point as its own
     process and only sets environment variables. It does not import gateway
     code. Results are read in one place (`results.ts`): PostgreSQL directly
     today, the ledger read API later.
   - **Chaos proxy.** The gateway's upstream points at a small proxy that
     forwards traffic unchanged, reports when calls start, stream, and end,
     and can cut one turn stream after its first delta. Fault injection stays
     out of the gateway (ADR 0004).
   - **Isolation.** A sandbox repo with dummy files and a generic git
     identity, reset before every scenario, and separate harness logins
     (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), all in `../seeit-iris/` next to
     the repo. Claude Code runs with `--strict-mcp-config` and
     `--disable-slash-commands`: a fresh config still syncs the account's
     plugins and skills, and these flags keep them out of the requests.
   - **Structure, not text.** Expected results check structure (turns, kinds,
     completion, flags, drift), not exact text or call counts.
   - **Two observers.** The chaos proxy records what each response held; the
     checker (`check.ts`) compares that with the ledger. A scenario fails
     when it did not exercise its feature, when the gateway lost a call, or
     when both sides disagree on an unfinished stream.
   - **Leak check.** A run fails when text from the owner's own setup
     reaches a request (`~/.agents/skills`, MCP tools). Iris gives the Codex
     process an empty `HOME`.
   - **Cost.** Scenarios use lightweight models. Run only the scenarios a
     change affects (AGENTS.md); a full run takes about 12 minutes.
   - **Done:** headless scenarios and the checker, passing on Claude Code
     2.1.326 and Codex 0.169.1, including MCP, skills, plugins, and compaction.
     **Open:** a `tmux` driver for interactive-only actions (Esc interrupt,
     Codex `/compact`); request-body redaction for fixtures (home paths,
     `account_uuid` inside `metadata.user_id`, `device_id`,
     `installation_id`, Claude Code's git status block); fixtures from a run;
     an `/iris` skill. Iris never commits anything: fixtures go through
     redaction and hand review. **Not covered yet:** nested subagents and
     Claude Code's automatic compaction.
5. **Flagged calls become fixtures (layer 4). Open.** Let `make-fixture`
   (today it reads a recording file) read a call from the ledger by ID, so a
   flagged call can become a reviewed regression test.
6. **Better output estimate for cut streams. Open.** Replace the
   4-characters-per-token rule with a tokenizer count of the received text,
   as LiteLLM does in `_recover_interrupted_stream_output_tokens`.

### Live-run findings (2026-11-14)

From `claude -p "Reply with just the word: pong"` runs on Claude Code 2.1.133
and 2.1.311.

1. **Connectivity check.** 2.1.133 sends `HEAD /claude` (Anthropic answers
   `404`); 2.1.311 sends `HEAD /api/hello` (`200`). Both carry the Bun
   runtime's user-agent and no session ID. Rules: a connectivity check is
   its own kind, any answer means it worked, and a runtime user-agent is not
   a harness version.
2. **Session-title request.** 2.1.133 sends a Haiku call in parallel with the
   first turn, asking for a session title, with `tools: []`. It is
   `background` only because the tool list is empty. Not seen on 2.1.311.
3. **Tool count depends on the version.** With the same MCP servers and
   plugins, 2.1.133 sent 133 tools (≈ 98k-token prompt) and 2.1.311 sent 11
   (≈ 19k tokens; MCP tools are deferred behind a tool-search tool). Tools can
   be most of the prompt, so feature A shows them as their own slice.
4. **Cache breaks, worked examples for B.** The cache key is a prefix in the
   order **tools → system → messages**.
   - Two runs 3 minutes apart both wrote the whole prompt (≈ 19.4k tokens, 0
     read): `tools[1]` (Bash) changed its description (background timeout
     "default 1800000 ms" → "default 600000 ms"), and the skills list came in
     a different order. A change in the second tool invalidates everything
     after it.
   - A later run read 10,474 and wrote 8,916. The only change was the git
     status snapshot in the first user message. The breakpoints were
     `system[1]`, `system[2]` (end of tools + system), and `messages[1]`; the
     change came after `system[2]`, so tools and system were read. Any git
     change between sessions causes this break on a session's first call:
     an **expected** break.
   - `metadata.user_id` (session ID) differs too, but metadata is not part
     of the cached prompt.
   The detector (B) finds the first point where two consecutive requests of
   the same setup differ, names its section and item, reports it relative to
   the breakpoints, counts the cost, and tells an unsorted list or other
   change for no reason from a real config change.
5. **Several installs per machine.** Claude Code and Codex can each be
   installed several times (Homebrew, bundled in desktop apps, the Codex
   app-server). Only the `PATH` install goes through the gateway. Check
   `which -a claude codex` and `--version` before comparing ledgers.
6. **The cache outlives sessions, and has two lifetimes.** The prompt cache is
   keyed on the exact prefix within the account, not on the session. Claude
   Code marks every main-agent breakpoint `ttl: "1h"`; the API default is 5
   minutes. The response splits cache writes by lifetime
   (`usage.cache_creation.ephemeral_5m_input_tokens` /
   `ephemeral_1h_input_tokens`), and a 1-hour write costs more. Both are
   stored.

### Iris findings (2026-11-17)

Claude Code 2.1.326 and Codex 0.169.0 (`codex exec`), headless. Each finding
has a unit test built from the recorded shape, and an Iris scenario.

1. **Claude Code sends `role: "system"` messages inside `messages`**, often
   last. Turn detection skips trailing system messages.
2. **Subagent rule (decided): a subagent's calls belong to the user's turn
   that started it, and `agent_id` says which agent made the call.** Claude
   Code marks subagent calls with the `x-claude-code-agent-id` header. Codex
   (`spawn_agent`) keeps the session ID but sends a new `turn_id` and
   `thread_id`; its turn metadata names the user's turn in `root_turn_id` and
   the parent in `parent_thread_id`. Feature F builds the tree from
   `agent_id`.
3. **Harness-written user messages are not prompts.** A user message that
   holds only `<system-reminder>` blocks ("[SYSTEM NOTIFICATION - NOT USER
   INPUT]") does not start a turn.
4. **A tool can make its own model calls, and they belong to the turn.**
   Claude Code's WebSearch tool sends a call with only the `web_search`
   server tool, and sometimes a second call with no tools that reads the
   fetched page. Neither names the turn; the only link is the session ID.
   Rules:
   - A call offering a client tool **or a server tool** is a turn call; only
     a call with a client tool can **start** a turn.
   - **Background calls with a session ID are linked to the session's turn
     in progress** (`turn_id` set, `kind` stays `background`). Before the
     first turn there is nothing to link to. Codex's `POST /alpha/search` is
     linked the same way.
5. **Stream recovery.** After a dropped stream Claude Code sends the request
   again by itself. If no answer text had arrived, the request is identical.
   If the stream was cut mid-answer, the same user message gains one text
   block ("Your response above was cut off mid-stream. Resume directly from
   where it stops ...") and a newline at the end of the prompt block. Both
   stay in the turn (`resendsTurnStart`). Codex retries with its own turn ID.
6. **`/compact` is a model call with tools.** A compaction is not a turn
   (ADR 0009): with the `x-claude-code-compaction` hint header it is
   `background`. Without the header it cannot be told apart and stays a turn
   of its own. The next prompt is a new turn.
7. **Codex web search** runs as a separate `POST /alpha/search` request, and
   only on Codex's built-in provider: with the custom provider from the
   README the tool is not offered.
8. **Codex's built-in provider tries a Responses WebSocket first**
   (`GET /responses`). The gateway does not proxy WebSockets (405); Codex
   falls back to HTTP after about 9 seconds. Supporting WebSockets is not
   planned; keep recommending the custom provider.
9. **Unknown block and delta types are drift**, counted in `unknown_events`
   (for example `citations_delta`). A `compaction_delta` summary counts as
   output.
10. **Codex compaction is a separate call**, a `POST /responses` with turn
    metadata `request_kind: "compaction"`. It is `background` and linked to
    the turn that triggered it.
11. **Codex hooks** use the same `hooks.json` format as Claude Code, in a
    project's `.codex/` folder, and run only in a trusted project with
    trusted hooks. Plain stdout from a `UserPromptSubmit` hook is added to
    the prompt, as in Claude Code.
12. **A lightweight model may skip thinking.** The thinking scenario uses
    `--effort high` and a harder question.
13. **Redaction.** `anthropic-organization-id` and `x-codex-turn-state` are
    redacted. `x-codex-turn-metadata` is kept (turn and agent IDs); it holds
    `installation_id`, which fixture redaction must remove.

### Field inventory, prompt caching, and compaction (2026-11-18)

From every field of 305 Claude Code 2.1.326 and 283 Codex 0.169.1 Iris
recordings. The inventory read field names and short setting values only,
never text. The ledger data model stores these facts (ADR 0009, "Context
parts, caching, and compaction detail"); feature I shows them.

**Settings.** No harness setting sends more data than what is listed here.
Claude Code needs `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` (Iris sets it). Codex
sends everything below by default. The `include_*_usage_instructions` and
`supports_reasoning_effort_updates` fields in Codex's `/models` catalog are
server-side model settings, not user settings.

**Startup context**

1. **Codex reports exact tokens per input item.** `response.completed` →
   `usage.attribution.items` maps each item ID to `input_tokens`,
   `cached_tokens`, `cache_write_tokens`, and `output_tokens`, with a
   `content` array that has the same four counts per content part. It was on
   172 of 181 `/responses` calls; the others were cut or interrupted. The
   keys are the `id` fields of the request's input items, plus the response's
   own output items. **The keys come sorted by ID, not in input order: map
   them by ID, never by position.** ID prefixes: `at` additional_tools,
   `msg` message, `ctc` / `ctco` custom tool call / output, `fc` / `fco`
   function call / output, `rs` reasoning, `amsg` agent message, `cnfu`
   configuration update (no `id` in the request; not mapped yet). A first
   call:

   | Input item | Chars | Tokens |
   | --- | --- | --- |
   | `additional_tools` (functions, clock, collaboration namespaces) | 28,042 | 5,712 |
   | Developer: base instructions (same text as `/models` `base_instructions`) | 17,793 | 3,456 |
   | Developer, 5 parts: `<skills_instructions>`, `<permissions instructions>`, `<collaboration_mode>`, `<tools>` (deferred MCP namespaces), `<recommended_plugins>` | 2,151 / 594 / 1,056 / 2,471 / 780 | 487 / 139 / 199 / 517 / 235 |
   | Developer: `<multi_agent_role>` | 2,400 | 534 |
   | Developer: `<multi_agent_mode>` | 271 | 56 |
   | User: `<environment_context>` | 1,060 | 293 |
   | User: the prompt | — | 26 |

2. **Claude Code reports totals only.** Its first request has a fixed layout
   that can be labeled reliably; the provider reported 14,345 input tokens
   for this one (≈ 2.8 characters per token overall):

   | Part | Where | Chars |
   | --- | --- | --- |
   | Billing block (`cc_version=…; cc_entrypoint=sdk-cli`) | `system[0]`, not cached | 74 |
   | Identity line and main prompt | `system[1]`, `system[2]` | 62 + 6,648 |
   | Project and user instructions, one file per `Contents of … (user's private global instructions …)` / `(project instructions …)` header | `messages[0]`, first `<system-reminder>` | 3,480 |
   | Context and git-attribution reminders | `messages[0]`, next blocks | 967 + 582 |
   | The prompt | `messages[0]`, last block | 64 |
   | Environment | a `role: "system"` message | 2,936 |
   | Tool definitions, 12; deferred tools marked `defer_loading: true` | `tools` | 24,785 |

   Per-part counts are estimates. The two tokenizers differ (Codex: about
   4.9 characters per token for tool JSON and 5.1 for prose; Claude: about
   2.8 overall). **Cache breakpoints give exact anchors:** a cache read ends
   at a breakpoint, so a read of exactly the prefix up to `system[2]` is the
   exact size of tools + system (11,528 tokens on 16 main-agent calls).
   Anthropic's `count_tokens` endpoint could count each part exactly, but
   only as a separate request with the user's credentials; use it, if at
   all, in Iris to check the ratios, never in the gateway.

**Prompt caching**

3. **Claude Code sets up to 4 breakpoints** (the API maximum). The prefix
   order is tools → system → messages. Breakpoints: `system[1]`, `system[2]`
   (the end of tools + system; tools have no breakpoint of their own), then
   either the last assistant and last user message or the trailing
   `role: "system"` message.
4. **Two cache lifetimes, chosen per agent.** The main agent marks every
   breakpoint `ttl: "1h"`. Subagents and the compaction call use the default
   5 minutes and write their own prefix, because their system prompt and
   tools differ. The cache is shared across sessions (live-run finding 6).
5. **Some Claude Code calls are never cached.** The web-search call (one
   message, one tool, no breakpoints) reads about 11,000 tokens of search
   results uncached; its `usage.iterations` has two entries with their own
   counts.
6. **Context editing is a third mechanism.** Every Claude Code request sends
   `context_management.edits: [{type: "clear_thinking_20251015", keep:
   "all"}]`; the response reports `context_management.applied_edits` (empty
   on all calls so far). When it is not empty, it says which content the API
   removed before the model saw it.
7. **Codex caching is automatic.** There are no breakpoints. Each request
   sends `prompt_cache_key` (equal to the session ID), and the response
   reports `prompt_cache_retention: "24h"`. `cached_tokens` is a multiple of
   128: the cache boundary can fall inside an item. `cache_write_tokens` and
   its split by lifetime (`ttl_30m_tokens`, `ttl_12h_tokens`) were 0 on every
   call; they are stored anyway.
8. **Codex sends earlier reasoning again on every call** (`store: false`,
   `include: ["reasoning.encrypted_content"]`, `reasoning.context:
   "all_turns"`). Earlier reasoning items (`rs`) and subagent messages
   (`amsg`) cost input tokens (mostly cached); attribution counts them.
9. **Codex truncates tool output** before sending it: the catalog's
   `truncation_policy` is `{mode: "tokens", limit: 10000}`.
10. **How a Codex history starts** is in the turn metadata,
    `history_initialization`: `new`, `warm_fork` (a subagent starts from its
    parent's history and can reuse the parent's cache), or `cold_resume`
    (the history was rebuilt after an automatic compaction).

**Compaction**

11. **Claude Code compaction (manual).** The compaction call
    (`x-claude-code-request-class: compaction`, `x-claude-code-compaction:
    manual`) sends the same tools and system as the main agent, all messages,
    and one more user message with the compaction instructions, with
    5-minute breakpoints. In one run: 17,905 tokens read, 2,160 uncached, 53
    written; 1,143 output tokens (the summary). The next call's first message
    holds the summary; it read 12,132 (tools + system) and **wrote 6,846
    again**: the whole new history is a cache write, at the 1-hour rate.
12. **Codex compaction (`strategy: "memento"`).** A normal `POST /responses`
    with `request_kind: "compaction"` and `compaction: {trigger, reason,
    implementation: "responses", phase, strategy}`; `phase` is `pre_turn`
    (automatic) or `standalone_turn` (manual). It sends the whole history
    plus a user message with the compaction prompt. The answer is one
    `final_answer` message (79–133 output tokens). Afterwards the prefix
    stays (tools, developer messages, environment), then the earlier user
    prompts, the summary as a user message, and the new prompt; assistant,
    tool, and reasoning items are gone. `window_number` goes up by one. In
    one run the input fell from 15,138 to 11,865 tokens on each later call.
13. **Compaction does not always make the context smaller.** In the small
    Iris sessions, Claude Code's input went from 17,909 to 18,980 tokens
    after compacting, and the Codex manual compaction from 15,153 to 15,326.
    Measure before and after; never assume a saving.
14. **What decides when Codex compacts** is in the `/models` catalog:
    `context_window`, `max_context_window`, `auto_compact_token_limit` (null
    for all models seen; the user's `model_auto_compact_token_limit` setting
    applies), and `comp_hash` (the compaction prompt's version). Claude Code
    makes no catalog call; its windows come from the price file, and its
    automatic threshold is not visible to the gateway.
15. **The API can say why the cache missed.** Every Claude `message_start`
    has `message.diagnostics` (`null` on all Iris calls). When set it holds
    `cache_miss_reason: {type, cache_missed_input_tokens}`, with types
    `previous_message_not_found`, `model_changed`, and `unavailable`. B shows
    it first when it is present.

**Other fields stored**

| Harness | Field | Use |
| --- | --- | --- |
| Codex | Turn metadata `turn_started_at_unix_ms` | Order of requests from the harness itself (ADR 0008) |
| Codex | Turn metadata `request_kind` (`turn`, `compaction`, `prewarm`, `memory`) | Call kind as the harness states it |
| Codex | Turn metadata `turn_trigger`, `agent_name`, `reasoning_effort` | What started the turn, which agent sent it, and its effort |
| Codex | `x-codex-beta-features` | Feature changes between versions |
| Claude Code | `system[0]` billing block (`cc_version`, `cc_entrypoint`) | The exact build, and CLI or SDK |
| Claude Code | `x-stainless-retry-count` | The harness's own retry counter |
| Claude Code | `anthropic-beta` list | Feature changes between versions |
| Claude Code | Usage `service_tier`, `inference_geo`, `speed` | How and where the request was served |
| Claude Code | `output_config.effort`, `thinking.type` | Effort and thinking settings per call |

### Gateway compared with the harnesses' session files

Both harnesses write a session file on the local machine (Claude Code:
`~/.claude/projects/<project>/<session>.jsonl`; Codex:
`~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`). Checked on 2026-11-18,
field names and numbers only.

- **Only the gateway has:** every call, including background calls, harness
  retries, and failed calls; timings; completion status; the exact request
  (system prompt, tool definitions, injected reminders, in order); Codex
  per-item cache state; Claude plan-quota headers; and the ability to act
  before a request (budgets, routing). Its format is the provider API, which
  changes less than the files.
- **Only the session files have:** Claude Code `compactMetadata` (`trigger`,
  `preTokens`, `postTokens`, `durationMs`, `cumulativeDroppedTokens`),
  including automatic compactions, which Iris cannot trigger; tool and
  thinking durations; `attributionSkill` / `attributionPlugin`; Codex
  `content_token_count` per item and `model_context_window`; and sessions
  from installs that do not use the gateway. The files are undocumented
  internals that change between versions, hold full content and paths, and
  Claude Code deletes old ones.
- **Decision:** the gateway stays the source of truth. A later, optional
  importer adds file-only facts to calls the ledger already has, matched by
  `provider_request_id`. It never creates calls, and it reads labels and
  numbers only, never content or paths. See Phase 2.
