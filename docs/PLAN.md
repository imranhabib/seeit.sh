# seeit.sh — Plan

A single-user, local-first AI gateway that sits between coding harnesses
(Claude Code, Codex) and their model providers. It answers one question:
**where do my tokens go, and why?**

The project is also a learning project. The goal is to understand how data
flows through an LLM gateway, its major parts, and the code paths that are
critical for performance.

## Scope

- **Users:** one (the owner). No multi-tenant features.
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

This is the confirmed target architecture. The current implementation still
uses an embedded SQLite ledger. [ADR 0007](adr/0007-ledger-service-and-postgres.md)
records the replacement and the service boundary; the historical Phase 1
sections below describe what was built, not a second supported storage engine.

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
  and writes, schema migrations, retention, and derived analysis. The dashboard
  and CLI use its read endpoints. Write credentials belong to the gateway;
  browser clients have read access only. Initial parser placement remains as
  implemented; moving usage/context parsing out of the gateway is a separate
  change and does not move the gateway's credential-scrubbing responsibility.
- **PostgreSQL:** the single target ledger database. The ledger owns access,
  but PostgreSQL runs as a separate process/container. Its placement can change
  without changing the gateway-to-ledger contract.
- **Dashboard:** the same frontend serves standalone and Morpheus access.
  The ledger service can serve the built static frontend; development uses Vite.

| Mode | Gateway and ledger | PostgreSQL | Service addressing |
| --- | --- | --- | --- |
| Native local, no Docker | Separate Node processes on one machine. | Locally installed PostgreSQL with persistent data. | Loopback HTTP and a local database connection. |
| Docker local | Separate gateway and ledger containers started with Compose. | Separate PostgreSQL container with a named persistent volume. | Compose service names; publish user-facing ports on host loopback. |
| Cloud | Gateway and ledger containers on separate instances/deployment units. | Initially a separate container with persistent storage on the ledger instance; can move to a dedicated database service. | Configured private network addresses and authenticated service requests. |

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
horizontal gateway replicas also require coordinated turn tracking and future
budget counters before they are safe. Do not introduce orchestration as part
of the frontend work.

PostgreSQL data must survive application/container restarts and replacement in
both local modes and the cloud. Document native data-directory ownership and
Docker volume lifecycle, including that deleting a volume deletes its data.
Persistence and backups are separate concerns. The ledger waits for database
readiness; a running container alone is not a readiness check.

### Recording delivery rules — identical in every mode

- The gateway never waits for ledger ingestion or a database acknowledgement
  before forwarding provider chunks or finishing the harness response.
  Ledger downtime must not turn recording into a new forwarding dependency.
- Initially send completed call metadata and captured bodies after collection
  finishes, including interrupted-call records. Sending live recording streams
  and moving parser work are separate implementation decisions.
- Generate a stable call ID before collection. Retrying a recording with that
  ID must not insert a second call, duplicate bodies, or double-count usage.
  Acknowledge successful ingestion only after its database transaction commits.
- Bound request timeouts, retries, and pending recording count/bytes. A slow
  ledger must not create unbounded memory use or backpressure on the client
  stream. Make delivery failures and queue saturation visible without logging
  credentials or captured content. Serialization and delivery still consume
  gateway resources and need concurrent-stream verification.
- Apply the same authentication, validation, idempotency, and retry behavior
  over loopback, Compose networking, and cloud networking. Change configuration
  between deployments, not delivery semantics.
- **V1 delivery is best effort:** use bounded in-memory pending recordings and
  retries. There is no durable outbox or restart replay. Unacknowledged records
  can be lost on gateway restart, exhausted retries, or queue saturation; a
  record already committed by the ledger remains stored even if its
  acknowledgement was lost. Specify queue limits and overflow handling in the
  gateway-delivery PR and make recording loss visible without captured content.
  Do not claim lossless delivery. Verify delayed/lost acknowledgements,
  duplicate delivery, outage/recovery, saturation, and restart behavior.
- **V2 follow-up:** reconsider a bounded durable outbox on gateway-local
  persistent storage after the v1 services and dashboard are complete. Its
  storage format, disk limits, overflow policy, retention, and restart replay
  are deferred decisions; they do not block v1. Gateway credential scrubbing
  must precede any future outbox write. Existing debug recordings are not a
  supported delivery outbox or replay mechanism.

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

- **Trace hierarchy:** Session → Turn → Call.
  - Session: one `claude` / `codex` run.
  - Turn: one prompt the user types, plus every model call and tool loop until
    the final answer. Inferred (best effort): a new turn starts when the last
    message is new user text, not a `tool_result`.
  - Call: one HTTP request to the model.
- **Call kind: not every call is a turn.** Harnesses also send background
  calls that the user did not trigger, for example Claude Code's
  `HEAD /api/hello` connectivity check and its `"quota"` probe (`max_tokens: 1`,
  sent at startup to read the plan-quota headers). These are labeled
  `background` so they do not count as turns or skew per-turn metrics. Their
  tokens still count toward totals and budgets.
- **PostgreSQL ledger** ([ADR 0007](adr/0007-ledger-service-and-postgres.md)): one
  row per call with harness, session, turn, model, input / output / cache-read /
  cache-write tokens, estimated cost, latency. It is the source of truth for
  budgets and the custom dashboard, owned by the separate ledger service.
- **Timings per call** (milliseconds from when the gateway received the
  request, measured with the monotonic `performance.now()` clock):
  - `timeToResponseHeadersMs`: upstream status and headers arrived. Network,
    auth, and queueing. The ChatGPT backend sends headers only when the model
    is ready, so for Codex this already includes model time.
  - `timeToFirstChunkMs`: first body chunk arrived. Usually a metadata event
    (`message_start`), not answer text.
  - `timeToFirstTokenMs` (Phase 1): first model output arrived. The real
    time to first token. It is the first delta that carries text the model
    wrote (answer text, thinking text, tool input), or the start of an
    output block that arrives whole (`redacted_thinking`). Empty deltas
    (the empty `input_json_delta` that opens every tool call, the empty
    `thinking_delta` with thinking `display: "omitted"`) and
    `signature_delta` do not count. For Codex, only deltas that carry model
    text count, not every `*.delta` (a server-run shell command's stdout
    arrives as `response.shell_call_output_content.delta`).
  - `timeToStreamEndMs`: stream ended.
  - Derived: prefill time ≈ `timeToFirstTokenMs − timeToResponseHeadersMs` (shorter
    on cache hits, ties into B); output speed = `output_tokens ÷ (timeToStreamEndMs −
    timeToFirstTokenMs)` tokens per second.
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
- **Bodies:** full request and response bodies, gzipped, 14-day retention.
- **Traces:** OpenTelemetry (GenAI semantic conventions) exported to a
  self-hosted Langfuse.
- **Prices:** a pinned copy of LiteLLM's `model_prices_and_context_window.json`
  plus local overrides. Never fetched at runtime. Cache-read and cache-write
  prices must be correct.

### Budgets

- Units: tokens and estimated USD. Plan-quota % later, if the quota headers are
  reliable.
- Scopes: global per day and per month, per harness. Per session later.
- Checked **only before a request is sent**. A stream is never cut off mid-way
  ([ADR 0004](adr/0004-no-mid-stream-cutoff.md)).
- A blocked request gets an error in the provider's own format (for example an
  Anthropic-style `429`) so the harness shows it correctly.
- **Gateway blocks are labeled.** Upstream also returns `429`s (seen in Phase 0
  on the startup quota probe), so the gateway adds its own header
  `x-seeit-blocked: budget` to every block it makes. The ledger stores who
  blocked the call (`upstream` or `gateway`), so the dashboard can tell
  "Anthropic said no" from "my budget said no."
- A warning is logged at 80%.

### Security

- Never store or log `Authorization`, cookies, or account-ID headers. Redact
  them in the gateway's recording copy before any write or transmission to the
  ledger. Use the redaction helper and extend it for credential-bearing fields
  included in the ingestion contract; current header redaction alone does not
  establish that arbitrary body content is secret-free. Scrubbing must not
  change the request or response bytes forwarded between harness and provider.
- Bind to `127.0.0.1` locally.
- Server deployment: no public port. Reach it over Tailscale and require a
  gateway token in a custom header (`ANTHROPIC_CUSTOM_HEADERS` for Claude Code,
  `env_http_headers` for Codex).
- Stored bodies contain code and possibly secrets. Keep the data directory on an
  encrypted disk.

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

A `seeit` command for running and inspecting the gateway from a terminal. It
replaces the ad-hoc tools used so far: the `q()` sqlite3 helper,
`pnpm summarize`, and calling `make-fixture.ts` by hand. The dashboard is for
browsing and charts; the CLI is for quick answers and scripting.

**Naming rule.** Commands follow the data model (Session → Turn → Call). A
plural noun lists (`calls`), a singular noun shows one (`call <id>`).

| Command | What it answers | Phase |
| --- | --- | --- |
| `seeit start` | Run the gateway (later: as the `launchd` service) | 1 |
| `seeit status` | Is the gateway up, which database, is each harness pointed at it | 1 |
| `seeit setup claude\|codex` | Print the base-URL settings for a harness | 1 |
| `seeit sessions [--harness --since]` | Recent sessions | 1 |
| `seeit session <id>` | Turn → call tree with tokens, cache, flags (subagents with F) | 1, then 3 |
| `seeit calls [--session --kind --flagged]` | Recent calls | 1 |
| `seeit call <id> [--request --response]` | Timings, usage, completion, flags; stored bodies for debugging (context breakdown with A) | 1, then 2 |
| `seeit drift` | Unknown event types, usage fields, and invariant flags per harness version | 1 (follow-up 1) |
| `seeit fixture <call-id\|session-id> -o <file>` | Redacted test fixture from the ledger | 1 (follow-ups 4–5) |
| `seeit sql "<select>"` | Legacy local SQLite escape hatch; revisit after the PostgreSQL migration | deferred |
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
  do not open the database or route reads through the gateway. This works with
  native local processes, containers, and a remote ledger service (ADR 0007).
- **`seeit sql` is deferred.** Its earlier local SQLite-file design no longer
  fits the target architecture. Do not add a raw SQL HTTP endpoint or give the
  ordinary CLI PostgreSQL credentials to preserve that old implementation.
- **`seeit fixture` keeps the hand review.** It writes to a file and prints a
  reminder that the repo is public; it never writes into the test folders
  itself.
- **No new dependency for argument parsing.** Use Node's built-in
  `util.parseArgs`.
- **Developer tasks stay in the `justfile`** (`just reset`, `just test`). The
  CLI is for operating and inspecting the gateway, not for working on its
  code.
- **Build order:** `calls`, `call`, `sessions`, `session` first. They
  replace `q()` right away. The rest arrive with the phase that adds their
  data.

## Stack

TypeScript on Node 24 LTS with Hono ([ADR 0002](adr/0002-typescript-node-hono.md)).

```
apps/gateway      Hono proxy server
apps/ledger       Separate HTTP service; owns PostgreSQL storage and read/write APIs
apps/dashboard    Vite + React custom dashboard (Phase 2)
apps/cli          `seeit` command (see *CLI*)
packages/core     shared parsers and pricing helpers
packages/contracts shared ledger HTTP request/response contracts when needed
infra/            Dockerfiles, Compose, native setup and service deployment docs
docs/             this plan, ADRs
```

Target: PostgreSQL through an asynchronous driver with Drizzle, owned by
`apps/ledger`. Phase 1 used SQLite through `better-sqlite3`; preserve existing
migration history and decide how existing recordings are imported before
cutover. Tests use Vitest; ledger integration tests must also run against a
configured native PostgreSQL instance without requiring Docker.

## Differentiators

What existing tools (LiteLLM, Portkey, Helicone, Langfuse, `ccusage`, the
harnesses' own OTel export) do not do: understand the *contents* of agent
traffic.

| ID | Feature                         | Phase   |
| -- | ------------------------------- | ------- |
| A  | Context composition breakdown   | 2       |
| B  | Cache-break detector            | 2       |
| C  | Plan-quota forecast             | 2       |
| D  | Repo / branch attribution       | 3       |
| E  | Waste detection                 | 2       |
| F  | Subagent tree                   | 3       |
| G  | Soft budget actions (downgrade) | 4       |
| H  | Session diff replay             | stretch |

## Phases

### Phase 0 — Recorder spike

A minimal pass-through proxy that records redacted traffic to
`data/recordings/`. Use it to confirm:

- [x] The Codex upstream URL and paths.
- [x] How each harness sends a session ID (header or body metadata).
- [x] Where `usage` appears in each stream.
- [x] Whether plan-quota headers exist on responses (they do: feature C moves into Phase 2).

Save reviewed, redacted streams as test fixtures. How to run it, and the
findings: [phase-0-recorder.md](phase-0-recorder.md).

### Phase 1 — Pass-through proxy and ledger

**Status:** built on branch `phase-1-ledger` (2026-11-14). Everything below is
done except where marked. Verified live: one Claude Code and one Codex call
were recorded with correct usage (Codex's own total, 15,774 tokens, matched
the ledger exactly).

- **Replace the hand-written SSE parser with `eventsource-parser`** (runtime
  dependency approved). The Phase 0 parser was written to learn how SSE
  framing works; a maintained, spec-compliant library covers edge cases ours
  missed (lone `\r` line endings, a byte-order mark, `id` / `retry` fields,
  not dispatching an event that has no `data`).
  - Done as a thin wrapper in `packages/core/src/sse.ts` that keeps the
    `push` / `flush` API, so the existing tests (whole stream,
    1/2/3/7/13-character chunks) ran unchanged against the library as proof.
    The wrapper is fed chunk by chunk (not `EventSourceParserStream`) because
    the gateway also needs the raw text for body storage and a timestamp per
    event.
  - Unfinished last event: **kept** on `flush()` (the spec drops it), to help
    the output-token estimate for truncated calls.
- Per-provider event interpreters on top of the parser: Anthropic Messages
  (`message_start` … `message_stop`) and OpenAI Responses
  (`response.created` … `response.completed`).
- Usage extraction, session and turn detection.
- Call-kind classification: `turn` vs `background` (connectivity checks, quota
  probes).
- `timeToFirstTokenMs` timing. The derived prefill time and output tokens per
  second are computed at query time from stored columns, not stored.
- **Version-tolerant parsing.** Harnesses change their request format between
  versions without notice. Example (Codex 0.153.4 → 0.169.0): tools moved from
  the top-level `tools` field to an `additional_tools` item in `input`, and the
  system prompt moved from `instructions` to `developer` messages in `input`.
  The parser must:
  - look for tools and instructions in **both** places;
  - treat Codex's usage `attribution` as **optional** (present in 0.153.4,
    missing in 0.169.0). Feature A therefore needs the gateway's own token
    estimate as a fallback for Codex too, not only for Claude;
  - store the harness version (from `user-agent`) on every call, so a parser
    failure can be traced to a specific version;
  - keep one recorded fixture per harness version it supports.
- Completion status for every call, and output-token estimates for truncated
  calls (see *Completion status per call*). Tests: fixtures cut mid-event,
  cut between events, with an error event, and complete-then-closed.
- SQLite ledger (`data/seeit.db`, tables `calls` and `bodies`) and gzipped
  body storage with 14-day pruning. Migrations are generated by drizzle-kit
  and applied at gateway startup.
- Streaming integration test (first byte before upstream finishes).
- **Not done yet:** estimated USD cost. It needs the pinned price file (see
  *Prices*), so it moves to Phase 2 together with the dashboard that shows it.

#### Phase 1 follow-ups: gaps from Anthropic's streaming spec

Found by reading [Anthropic's streaming
docs](https://platform.claude.com/docs/en/build-with-claude/streaming) after
Phase 1 was built. Gaps 1 and 2 affect cost accuracy, so fix them before the
Phase 2 cost estimates.

1. **The model can change mid-stream (server-side fallback).** A `fallback`
   block marks each model boundary. The interpreter takes `model` only
   from `message_start`, so after a fallback the ledger records the wrong model
   and cost uses the wrong price. Fix: read the serving model from the
   `fallback` block's `to.model`, and from the `fallback_message` entry in the
   final `message_delta`'s `usage.iterations` ([refusals and fallback
   docs](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback),
   "Streaming"). (`input_transformations` also carries it, but only under a
   beta header.) Test with an example built from the docs (a fallback cannot
   be triggered on demand). After a fallback, the top-level `usage` counts
   only the serving model; every earlier attempt is billed too and is listed
   only in `usage.iterations`. Such calls are flagged `fallback_usage_partial`
   until Phase 2 prices each attempt.
2. **Server tools change input tokens mid-stream.** In the docs' web-search
   example, `message_start` reports `input_tokens: 2679` and the final
   `message_delta` reports `10682`, because search results become input. The
   cumulative merge already takes the final value for complete streams, but a
   stream cut before `message_delta` keeps the low first value. Also,
   `usage.server_tool_use.web_search_requests` is billed per search and is not
   stored. Fix: store server tool counts in the ledger, and mark input as
   estimated when a cut stream contained server tool use.
3. **Some blocks arrive whole, with no deltas**: `redacted_thinking`, server
   tool results such as `web_search_tool_result`, and `fallback`. The output
   estimate and `timeToFirstTokenMs` only look at deltas, so these blocks are
   invisible. Fix: count `content_block_start` content for these block types.
4. **An empty thinking delta counts as the first token.** With thinking
   `display: "omitted"`, the stream sends a `thinking_delta` with an empty
   string, then a `signature_delta`. `timeToFirstTokenMs` is set on that empty
   delta. Decided: first delta with text (see *Timings per call*). The same
   applies to Codex, where not every `*.delta` event is model output.
5. **Stream recovery may split turns.** For Claude 4.6 and later, the
   documented way to resume an interrupted stream is a new **user** message
   ("Your previous response was interrupted ... Continue from where you left
   off."). If Claude Code does this, the turn tracker starts a turn the user
   never typed. Record an interrupt-then-resume scenario to see what Claude
   Code actually sends, then adjust turn detection.

#### Phase 1 follow-ups: parser coverage ([ADR 0005](adr/0005-parser-coverage-strategy.md))

Do these in order. Step 1 protects real usage immediately; the rest build on
it.

1. **Live drift detection (layer 3).**
   - Count event types and usage fields the interpreters do not handle, per
     harness version. Log them and store them on the ledger row.
   - Check invariants on every call and store violations as flags: `complete`
     but no usage; `turn` without a turn ID; model in `message_start` differs
     from the final model with no `fallback` block; input tokens change between
     `message_start` and `message_delta` with no server tool use; estimated
     tokens on a `complete` call.
   - Flag the first call from a harness version that has no fixtures.
   - Label connectivity checks as their own kind (not `background`) with no
     failure status: a `404` on `HEAD /claude` is harmless (finding 1).
   - Take `harness_version` only from the harness's own user-agent
     (`claude-cli/…`; `codex_exec/…` for `codex exec`), never a runtime's
     (`Bun/…`). For a
     call without one, leave it null (finding 1).
   - Store tool count and tools size per harness version, so a version that
     changes them shows as expected drift, not a bug (finding 3).
   - Fix the Codex gaps found in `codex-rs/codex-api/src/rate_limits.rs`: the
     quota regex misses per-limit headers (`x-<limit_id>-primary-*` and
     `-secondary-*`, for example `x-codex-other-primary-used-percent` for
     limit `codex_other`; plus `x-<limit_id>-limit-name`), the
     `x-codex-credits-*` headers, `x-codex-rate-limit-reached-type`, and
     `x-codex-promo-message`; usage field `codex_rollout_budget_units` is not
     read. The server also sends window headers the client does not read
     (`x-codex-primary-reset-after-seconds`,
     `x-codex-primary-over-secondary-limit-percent`); keep those too.
2. **Spec-derived tests (layer 1)** for the five streaming gaps above, plus
   several `message_delta` events and mid-stream errors. Each test links its
   source (docs page, SDK type, or Codex source file at a pinned commit).
3. **Typed field access.** Add `@anthropic-ai/sdk` as a dev dependency and type
   the fields the interpreter reads with its beta types
   (`BetaRawMessageStreamEvent`, `BetaMessageDeltaUsage`). For Codex, use the
   `openai` SDK's types (dev dependency) for the standard fields, plus a small
   local type for the fields only Codex's backend sends
   (`codex_rollout_budget_units`, `attribution`), with links to the matching
   Codex source. Keep parsing fail-soft: every field optional. A missing usage field
   stays **unknown (null)**, not 0: `fromAnthropicUsage` / `fromOpenAIUsage`
   currently default missing fields to 0, which silently asserts "no tokens".
   Also store cache writes split by lifetime (5-minute and 1-hour columns,
   from `usage.cache_creation`), keeping the total; null when the split is
   missing. Phase 2 prices each lifetime separately (finding 6).
4. **Risk-ranked scenario recordings (layer 2).** In a throwaway sandbox repo
   with dummy content, record per harness: long tool loop, subagent,
   compaction, interrupt-then-resume, a hook that injects context, web search,
   visible thinking. Store each as an ordered list of request/response pairs
   with written expected results (turn IDs, kinds, completion, usage). Extend
   `make-fixture` to redact request bodies (home paths, `account_uuid`,
   `device_id`, `installation_id`; `account_uuid` sits inside
   `metadata.user_id`, a JSON string; Claude Code's git status block in the
   first user message, which holds the git user name, branch names, and
   recent commit messages). The subagent rule is decided (same turn,
   with `agent_id`; see the Iris findings below), which feeds feature F. Also record whether
   current Claude Code still sends a session-title request in an interactive
   session (finding 2).

   **Iris** (`apps/iris`, `pnpm iris run`) automates these recordings, so
   they can be repeated whenever a new harness version appears (the
   `untested_harness_version` flag). Decisions:
   - **Black box.** Iris starts the gateway's real entry point as its own
     process and only sets environment variables. It does not import gateway
     code, so Phase 1C's changes to gateway internals do not break it. Results
     are read in one place (`results.ts`): the SQLite ledger today, the ledger
     service's read API after Phase 1C.
   - **Chaos proxy.** The gateway's upstream points at a small proxy that
     forwards traffic unchanged, reports when calls start, stream, and end,
     and can cut one turn stream after its first delta (the dropped-stream
     scenario). Fault injection stays out of the gateway (ADR 0004).
   - **Isolation.** A sandbox repo with dummy files and a generic git
     identity, reset before every scenario, and separate harness logins
     (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), all in `../seeit-iris/` next to
     the repo. Claude Code runs with `--strict-mcp-config` and
     `--disable-slash-commands`: a fresh config still syncs the account's
     plugins and skills, and these flags keep them out of the requests.
   - **Structure, not text.** Model output varies between runs, so expected
     results check structure (turns, kinds, completion, flags, drift), not
     exact text or call counts.
   - **Two observers.** The chaos proxy records on its own what each
     response held (event, block, and item types; whether the final event
     arrived). The checker (`check.ts`) compares that with the ledger, so a
     scenario fails when it did not exercise its feature, when the gateway
     lost a call, or when both sides disagree on an unfinished stream.
     `pnpm iris run` exits with code 1 on any failure.
   - **Leak check.** A run fails when text from the owner's own setup
     reaches a request (`~/.agents/skills`, MCP tools). Codex loads skills
     from `~/.agents/skills` even with its own `CODEX_HOME`, so Iris gives the
     Codex process an empty `HOME`.
   - **Cost.** Scenarios use lightweight models (`claude-sonnet-5-5`,
     `gpt-6-luna`). Run only the scenarios a change affects (AGENTS.md); a
     full run takes about 12 minutes.
   - **Order.** (1) foundation, headless scenarios, and the checker (done:
     18 scenarios, 9 per harness, pass on Claude Code 2.1.326 and Codex
     0.169.1); (2) a `tmux`
     driver for interactive-only actions (Esc interrupt, Codex `/compact`);
     (3) request-body redaction for fixtures, and fixtures from a run;
     (4) an `/iris` skill that runs it on a new harness version. Iris never
     commits anything: fixtures still go through redaction and hand review.
   - **Not covered yet.** Nested subagents, Claude Code's automatic
     compaction, Esc interrupt, and Codex's `/compact` command.
5. **Flagged calls become fixtures (layer 4).** Let `make-fixture` read a call
   from the ledger by ID (bodies are kept 14 days), so a call flagged in step 1
   can become a reviewed regression test.
6. **Better output estimate for cut streams.** Replace the 4-characters-per-
   token rule with a tokenizer count of the received text, as LiteLLM does in
   `_recover_interrupted_stream_output_tokens`. The 4-character rule is rough,
   and code and non-English text tokenize differently from prose.

#### Phase 1 follow-ups: findings from Iris runs (2026-11-17)

Claude Code 2.1.326 and Codex 0.169.0 (`codex exec`), headless. Each finding
has a unit test built from the recorded shape, and an Iris scenario.

1. **Claude Code sends `role: "system"` messages inside `messages`**, often
   last (environment notes, newly available tools). Turn detection looked at
   the last message only and missed the user prompt before it. It now skips
   trailing system messages.
2. **Subagent rule (decided): a subagent's calls belong to the user's turn
   that started it, and `agent_id` says which agent made the call.** Claude
   Code marks subagent calls with the `x-claude-code-agent-id` header. Codex
   (`spawn_agent`) keeps the session ID but sends a new `turn_id` and
   `thread_id`; its turn metadata names the user's turn in `root_turn_id` and
   the parent in `parent_thread_id`. The ledger stores the agent ID in
   `agent_id` (gateway migration 0005; ledger service migration 0001), which
   feature F can build the tree from.
3. **Harness-written user messages are not prompts.** A background subagent
   reports back through a user message that holds only `<system-reminder>`
   blocks ("[SYSTEM NOTIFICATION - NOT USER INPUT]"). Such a message does not
   start a turn.
4. **A tool can make its own model calls, and they belong to the turn.**
   Claude Code's WebSearch tool sends a call with only the `web_search`
   server tool, and sometimes a second call with no tools that reads the
   fetched page (56k input tokens in one run). Neither carries anything that
   names the turn: no agent ID, no turn marker; the only link is the session
   ID (checked field by field; the `cc_version` suffix in the billing line
   changes per session, so it does not mark the call type either). Rules:
   - A call offering a client tool **or a server tool** is a turn call; only
     a call with a client tool (the agent loop) can **start** a turn, since
     the server-tool call ends in text the tool wrote ("Perform a web search
     for ...").
   - **Background calls with a session ID are linked to the session's turn
     in progress** (`turn_id` set, `kind` stays `background`, so turn counts
     do not change). The link is inferred: a background row with a `turn_id`
     was linked this way. Before the first turn (the startup quota probe)
     there is nothing to link to. Codex's `POST /alpha/search` is linked the
     same way.
   - Effect in one run: the web-search turn showed 41,426 tokens; the prompt
     really cost 56,229. Per-turn totals now include such calls.
5. **Gap 5, answered.** After a dropped stream Claude Code sends the request
   again by itself. If no answer text had arrived, the request is identical.
   If the stream was cut mid-answer, the same user message gains one text
   block ("Your response above was cut off mid-stream. Resume directly from
   where it stops ...") and a newline at the end of the prompt block; no new
   message is added. Both stay in the turn: the turn tracker compares the
   position and per-block hashes of the message that started the turn
   (`resendsTurnStart`). Codex retries with its own turn ID.
6. **`/compact` is a model call with tools**, so it counts as a turn of its
   own; the next prompt is a new turn. Auto-compaction in the middle of a
   turn is not recorded yet and would probably split that turn.
7. **Codex web search** runs as a separate `POST /alpha/search` request, not
   as an item in the answer stream, and only on Codex's built-in provider:
   with the custom provider from the README the tool is not offered
   (`--search` has no effect with `exec`; `web_search="live"` is the setting).
8. **Codex's built-in provider tries a Responses WebSocket first**
   (`GET /responses`). The gateway does not proxy WebSockets: each attempt
   gets a 405, and after about 9 seconds of retries Codex falls back to HTTP
   streaming. The custom provider in the README does not try a WebSocket.
   Supporting WebSockets is not planned; keep recommending the custom
   provider.
9. **Unknown block and delta types are drift.** `citations_delta` was seen
   live and skipped silently. Block and delta types the interpreter does not
   know are now counted in `unknown_events`; a `compaction_delta` summary
   counts as output.
10. **Codex compaction is a separate call.** With a low
    `model_auto_compact_token_limit`, Codex sends a `POST /responses` whose
    turn metadata says `request_kind: "compaction"`. The gateway labels it
    `background` (no extra turn) and links it to the turn that triggered it,
    so its tokens count in that turn. After it, cache reads drop back to the
    prompt's base size. The proxy marks the request kind, so the scenario
    proves compaction happened.
11. **Codex hooks** use the same `hooks.json` format as Claude Code, in a
    project's `.codex/` folder. Codex runs them only in a trusted project
    with trusted hooks (`--trust`, `--dangerously-bypass-hook-trust` for
    automation that writes its own hooks). Plain stdout from a
    `UserPromptSubmit` hook is added to the prompt, as in Claude Code.
12. **A lightweight model may skip thinking.** With adaptive thinking at the
    default effort, `claude-sonnet-5-5` answered without a thinking block;
    the thinking scenario uses `--effort high` and a harder question.
13. **Redaction gap.** `anthropic-organization-id` (on every Anthropic
    response) was written to recordings. It and `x-codex-turn-state` are now
    redacted. `x-codex-turn-metadata` is kept: the gateway reads turn and
    agent IDs from it; it holds `installation_id`, which fixture redaction
    must remove.

#### Phase 1 follow-ups: findings from live runs (2026-11-14)

From re-running the Phase 1 "one prompt, one row" check on the laptop
(`claude -p "Reply with just the word: pong"`), before and after upgrading
Claude Code from 2.1.133 to 2.1.311 (Homebrew). Each finding names the version
it was seen on.

1. **Connectivity check.** The path depends on the version: 2.1.133 sends
   `HEAD /claude` (empty upstream path), which Anthropic answers with `404`;
   2.1.311 sends `HEAD /api/hello` → `200`. On both versions the request
   carries the Bun runtime's user-agent (`Bun/1.3.14`, `Bun/1.4.4`) and no
   session ID. So the ledger stored `upstream_error` for a harmless 404, a
   runtime version as `harness_version`, and a row that cannot be linked to
   its session. The fixes are in step 1 above.
2. **Session-title request.** 2.1.133 sends a Haiku call in parallel with the
   first turn (17 ms apart) asking for a 3–7 word session title. It has the
   turn's session ID and no turn ID. Its body has `tools: []`, so it is
   classified `background` only because the list is **empty**. A side
   request that ever sends a tool would be counted as a turn. Not seen in two
   `-p` runs on 2.1.311.
3. **Tool count depends on the version.** With the same MCP servers and
   plugins, 2.1.133 sent 133 tools (312,260 characters; prompt ≈ 98k tokens)
   and 2.1.311 sent 11 (22,620 characters; prompt ≈ 19k tokens). 2.1.311
   defers MCP tools behind a tool-search tool. Tools can be most of the
   prompt, so feature A shows them as their own slice.
4. **Cache break, a worked example for B.** Two 2.1.311 runs 3 minutes apart
   both wrote the whole prompt to cache (≈ 19.4k cache-write tokens, 0
   read). Comparing the stored request bodies:
   - `tools[1]` (Bash) description changed: background timeout "default
     1800000 ms" → "default 600000 ms". The second run was started from a new
     terminal tab; the cause (environment, settings, or a server-side flag)
     is not known.
   - The skills list in the first user message came in a different order.
   - `metadata.user_id` differed (session ID). Metadata is not part of the
     cached prompt.

   The cache key is a prefix in the order **tools → system → messages**, so a
   one-number change in the second tool invalidates everything after it. The
   detector (B) therefore: finds the first point where two consecutive
   requests of the same setup differ, names its section and item (`tools[1]`,
   Bash), counts the cost (cache-write tokens where a read was expected),
   and flags text that changes for no reason (an unsorted list) apart from a
   real config change. It needs request bodies, which the ledger keeps for 14
   days.

   A second break shows that **where** the change lands decides the cost.
   A later 2.1.311 run read only 10,474 tokens and wrote 8,916. The only
   change was the git status snapshot that Claude Code puts in the first
   user message (`(clean)` → `M docs/PLAN.md`, a file edited between runs).
   Cache hits are checked only at `cache_control` breakpoints; this request
   had three: `system[1]`, `system[2]` (end of tools + system ≈ 10.5k tokens),
   and `messages[1]`. The change came after the second, so tools and system
   were read and everything from the first message on was written again. The
   Bash timeout change came before the first breakpoint, so nothing was read.
   The detector reports the break point relative to the breakpoints ("broke
   at `messages[0]`, after `system[2]`; 8.9k tokens written again"). Any git
   change between sessions (edit, commit, branch switch) causes this break on
   a session's first call; within a session the snapshot is fixed. Treat it
   as an **expected** break, not a problem.
5. **Several installs per machine.** The laptop has Claude Code 2.1.311
   (Homebrew, on `PATH`) and 2.1.325 (bundled with the Claude desktop app),
   and Codex 0.169.0 (Homebrew, on `PATH`; 0.162.0 before upgrading),
   0.166.0-alpha.6 (bundled with ChatGPT.app), and 0.168.0 / 0.169.0 (the
   Codex app-server daemon). Only the `PATH` install goes through the gateway
   in the tutorial commands. Check `which -a claude codex` and `--version` on
   each machine before comparing ledgers.
6. **The cache outlives sessions, and has two lifetimes.** The prompt cache
   is keyed on the exact prompt prefix within the account, not on the
   session: separate `claude -p` runs (new session IDs) read each other's
   cache. Session IDs sit in `metadata`, which is not part of the cached
   prompt. Claude Code 2.1.311 marks every breakpoint
   `{"type": "ephemeral", "ttl": "1h"}`, so a prefix lives 1 hour after its
   last hit (the API default is 5 minutes). The response splits cache writes
   by lifetime (`usage.cache_creation.ephemeral_5m_input_tokens` /
   `ephemeral_1h_input_tokens`), and a 1-hour write is billed at a higher
   rate than a 5-minute one. The ledger stores only the total
   (`cache_write_tokens`), so Phase 2 cost would underprice every Claude Code
   cache write. Fix in step 3 above.

### Phase 1C — Ledger service and delivery (next)

Complete the service boundary before moving dashboard reads onto it. Keep the
existing gateway operational while the new ledger is built and tested. This
milestone uses the latest parser fields from main, including nullable usage,
cache writes by lifetime, server-tool use, and drift/completion flags.

Each row is a separate PR; split further if its review or learning scope grows.
After every PR, stop for a walkthrough of testing, code changes, reasons, and
known limits. Do not combine PostgreSQL migration, gateway cutover, and UI
changes in one PR.

| PR slice | Result | Verification |
| --- | --- | --- |
| Architecture and contract requirements | Publish ADR 0007, service ownership, gateway-side credential scrubbing, read/write permissions, and ingestion acknowledgement/idempotency requirements. Specify v1 best-effort delivery and defer the durable outbox to v2. | Review success, duplicate, timeout, and failure scenarios; distinguish implemented behavior from the target architecture. |
| PostgreSQL foundation | Add the standalone ledger package, native database setup, connection lifecycle, schema, and generated migrations. Preserve the latest parser fields and existing SQLite migration history. | Use a native PostgreSQL test database; store/read synthetic records and verify they remain after restart. No Docker requirement. |
| Recording ingestion | Add the authenticated write endpoint, concrete recording payload/validation, and transactional idempotent writes. Scrub recording credentials before they leave the gateway; never send raw authorization headers. | Duplicate submissions count once; a successful acknowledgement follows commit; invalid or unauthorized payloads are rejected. |
| Gateway delivery client | Add bounded in-memory pending recordings, request timeouts, retries, and observable failure/overflow handling. No durable outbox in v1. Keep the existing recording path until cutover. | Slow/unavailable ledger, lost acknowledgements, saturation, and restart-loss tests; no waiting on ingestion in the provider-streaming path. |
| Storage cutover | Switch gateway recording to the ledger service and remove gateway database ownership. Decide and document import/preservation of existing SQLite history before switching. | Gateway needs no database credentials; real calls reach PostgreSQL with correct usage/flags; credential scrubbing leaves forwarded provider bytes unchanged; concurrent streaming tests pass. |
| Ledger read API | Adapt PR #5's metadata selection, validation, pagination, errors, and tests to the separate ledger service with PostgreSQL. | Filtering, null/estimate semantics, safe JSON failures, and read/write authorization; dashboard reads never enter the gateway process. |
| Docker local packaging | Add gateway/ledger images, Compose, health checks, configuration examples, and persistent PostgreSQL volumes. Reuse the native application entry points. | Run the same ingestion/read/outage scenarios natively and with Compose; restart/recreate services and verify committed data remains. |

Native setup and commands are delivered with the ledger foundation, not held
until the Docker PR. Do not make native scripts depend on a container database.
The cloud milestone later reuses these images and delivery rules on separate
instances. Independent horizontal gateway scaling is separate work because
turn state and future budget counters need coordination.

Treat PR #5's gateway-mounted SQLite API as a draft precursor, not the service
boundary to merge. Its field selection, validation, errors, and tests are
useful inputs to the ledger read API PR. Parser scenario recordings and other
remaining parser follow-ups can proceed separately from this milestone.

### Phase 2 — Observability

- Pinned price file and estimated USD cost per call (moved from Phase 1).
  Price 5-minute and 1-hour cache writes separately (live finding 6).
  Price server tool use (`server_tool_use`, billed per search) and, after a
  server-side fallback, each attempt in `usage.iterations` at its own
  model's rates (calls flagged `fallback_usage_partial`).
- OTel export to Langfuse (Docker Compose).
- Custom dashboard: A, B, C, E.
- Frontend requirements and implementation order are defined below.
- Deliver the separate ledger service and PostgreSQL transition, then extend
  its read API for the dashboard and CLI. Support both native and Docker local
  operation before deployment to separate cloud instances.
- Quota tracking (C) uses only responses that carry quota headers. Responses
  without them (for example an upstream `429` with no
  `anthropic-ratelimit-unified-*` headers) are skipped, not read as zero.

#### Frontend delivery plan — agreed 2026-11-16

**Primary job:** answer “Why did this session use so many tokens?” Start with
an overview, find a session, inspect its accumulation over time, and expand
the turns and calls that explain it. Quota is supporting information.

**Delivery boundary:** build the dashboard plus the read API, derived
analysis, and storage needed to supply it. Make the Open WebUI changes in the
existing local fork, **morpheus**, a sibling checkout of this repository
(`../morpheus`).
Keep the PostgreSQL ledger, owned by the ledger service, as the source of truth.
Langfuse continues to handle general trace browsing under ADR 0003; seeit
provides enough session, turn, call, and request-excerpt detail to complete a
token investigation without leaving the dashboard. Full conversation replay
remains outside this release. Langfuse availability must not block seeit.

**Working baseline:** this plan was written in a separate worktree on branch
`frontend-plan`, based on `2daa70f`. At that point there was no dashboard or
read API. The ledger already stored usage, timing, session/turn identity,
tool/instruction character counts, raw quota headers, and gzipped bodies.
Other parser work is in progress: inspect and reuse it before implementation;
do not build competing versions of those changes.

**Architecture update:** the owner subsequently confirmed separate gateway
and ledger services, PostgreSQL owned by the ledger, optional local Docker,
and separate cloud instances. [PR #5](https://github.com/imranhabib/seeit.sh/pull/5)
contains an initial SQLite read API mounted in the gateway; it does not yet
implement this boundary. Reuse its metadata contract, validation, and tests
while revising the implementation to run in `apps/ledger`. Do not merge the
gateway-mounted design as the completed service architecture.

##### Pages and navigation

The Open WebUI sidebar has one **seeit** group with four links. The standalone
dashboard exposes the same destinations and direct URLs. Proposed routes:

| Page | Route | Content and main action |
| --- | --- | --- |
| Overview | `/overview` | Usage over time, quota summary, recent sessions, and evidence-backed findings; open a session or finding. |
| Sessions | `/sessions` | Searchable, filtered session list; open a session's accumulation and call detail. |
| Cache | `/cache` | Cache reuse and break findings; compare requests and inspect the first changed prefix. |
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
  excerpts while bodies remain available.

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
  Correct pricing needs cache-write lifetime splits and billable server-tool
  counts from the Phase 1 follow-ups. Unknown models or missing pricing inputs
  produce unavailable/partial estimates, never an apparent zero cost.
- Label timings according to the events actually measured. Resolve the
  existing first-token definition before calling it first visible answer
  text. Prefill is approximate; Codex response-header time already includes
  model time. Omit derived rates when their inputs are missing or invalid.

##### Quota behavior

Normalize each supported provider window without losing its source snapshot.
Show reported usage, reset time, and observation time. Missing quota headers
do not reset usage to zero; retain and age the last valid observation. Quota
may include account activity outside this gateway, so do not attribute every
quota change to a recorded session.

Forecast from comparable observations within the same window/reset period.
Never combine unrelated limits, cross a reset, or convert API-equivalent USD
into quota. Show the sample interval and “at your recent usage rate.” With
insufficient or stale observations, show the last known state and explain
that a forecast is unavailable. Define minimum sample coverage and freshness
rules with documented provider examples during implementation; test resets,
missing headers, flat usage, and decreasing/corrected observations.

##### Retention and ledger API

Persist compact, versioned derived measurements and findings independently of
raw bodies. Retain category/contributor measurements, safe tool labels,
relationships, and event/finding metadata with call history after the 14-day
body retention period. Raw content, excerpts, diffs, and copied source text
must follow body retention; do not retain them indirectly in finding payloads.
Older investigations keep charts and derived totals and explicitly show when
source evidence has expired. Record analysis failures and coverage gaps.

Analyze new calls in the ledger service after ingestion. Keep expensive
analysis bounded so it does not starve recording writes or dashboard reads.
Support an explicit, bounded backfill of still-retained bodies. Older rows
without bodies or previously stored analysis show “analysis unavailable.”
GET requests read stored results; they must not trigger unbounded body scans
or recompute the full ledger on each refresh.

Use the ledger service's read API for both dashboard and future CLI, under
ADR 0007. Define its authenticated gateway-ingestion contract separately from
browser read access. Start with plain typed responses and these read endpoints:

| Endpoint family | Responsibility |
| --- | --- |
| `/api/overview` | Filtered aggregates, coverage, recent sessions, and findings. |
| `/api/sessions` | Paginated sessions and summary metadata. |
| `/api/sessions/:id` | Harness-qualified session totals and charts; paginated turns/calls as needed. |
| `/api/calls` | Bounded call metadata list with filters and pagination. |
| `/api/calls/:id` | Call metadata, composition, tool contributions, and findings. |
| `/api/calls/:id/evidence` | Bounded, on-demand excerpts/diffs; explicit unavailable/expired state. |
| `/api/cache` | Filtered, paginated cache comparisons and findings. |
| `/api/quota` | Latest normalized windows, observations, and qualified forecasts. |

Specify query parameters, pagination, null/estimate semantics, and error
responses before wiring screens. No raw SQL endpoint. Do not expose stored
headers or secrets through summary payloads. Request content remains sensitive
and is loaded only when the user opens detail. Keep services loopback-bound
by default and verify how the local browser runtime reaches them.

##### Frontend behavior and Open WebUI integration

- Use the planned Vite + React app in `apps/dashboard`. Keep frontend code
  outside gateway watch paths so UI edits do not restart active streams.
  Use a development proxy for `/api`; prefer one origin for the installed
  dashboard and ledger API to simplify standalone and embedded access. Keep
  dashboard reads out of the gateway process and support direct page reloads.
- Use a compact, table-led desktop layout, dark by default, with clear
  typography and restrained composition/time charts. Smaller windows remain
  usable. Use keyboard-accessible controls, visible focus, chart legends,
  and equivalent numeric detail; do not convey state through color alone.
- Poll completed-call data on a modest interval, pause polling in hidden
  views, and preserve filters, selection, and scroll position. Show the last
  successful update and connection state. Keep existing data visible with a
  stale indicator on failure. No live stream token counters in this release.
- Distinguish loading, no recorded traffic, no filter matches, partial or
  unsupported analysis, expired evidence, and API failure. An empty chart
  must not imply measured zero usage.
- Use the existing **morpheus** Open WebUI fork. Add **seeit** using the existing sidebar group
  components and wire Overview, Sessions, Cache, and Quota links to browser
  tabs displaying the same frontend URLs. Reuse/focus an existing destination
  tab rather than creating duplicates. Tabs remain available across chat
  switches and do not create artificial conversations.
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
of how to test it, the changed code, and the reason for the change. Keep storage
migration, gateway delivery, deployment tooling, and UI slices separately
reviewable. The full release includes A, B, C, and E plus both frontend access
modes; early stages do not substitute for completion.

The storage, delivery, native setup, and Docker foundation is defined in
**Phase 1C — Ledger service and delivery** above. Frontend implementation uses
that service boundary. Synthetic data can support early visual review, and a
small Morpheus embedding proof should happen early to expose browser/network
constraints before the full dashboard is built.

1. **Confirm data contracts and the embedding path.** Reconcile ongoing
   parser changes, identify remaining usage/pricing gaps, and extend the ledger
   contracts with synthetic examples. In the separate
   **morpheus** Open WebUI fork, prove a sidebar link can open a local page through the
   selected browser mode and persist across chat switches. Verify a prototype
   can fetch its API. Record the pinned revision and local network setup.
   **Check:** no dependency on chat creation, no duplicate destination tabs,
   and a documented contract for unknown, partial, and expired data.
2. **Deliver the first usable investigation.** Add the dashboard shell,
   Overview, Sessions, direct call routes, and read endpoints over existing
   ledger fields. Add cumulative usage and turn/call tables, filtering,
   pagination, and completed-call refresh. Prepare representative screen
   states with synthetic data for visual review before expanding the charts.
   **Check:** ledger totals reconcile across pages; calls without sessions
   remain visible; refresh and browser navigation preserve the investigation.
3. **Add composition and session events (A).** Implement provider-aware
   analysis for categories, tool definitions/arguments/results, repeated input,
   and evidence-backed compaction events. Persist derived results with a new
   generated migration; add bounded backfill for available bodies. Complete
   the per-call charts, contributor expansion, timeline, and evidence views.
   **Check:** both harness formats are covered; missing identity stays
   unattributed; estimates do not masquerade as reported totals; deleting
   expired bodies preserves measurements and removes source excerpts.
4. **Explain cache behavior and surface findings (B, E).** Implement
   compatible-request selection, supported prefix/breakpoint comparison, and
   expected-versus-potentially-avoidable findings. Complete Cache and findings
   on Overview/session pages. Add accurate API-equivalent pricing after its
   prerequisite parser fields and pinned prices are ready.
   **Check:** worked examples from this plan distinguish a tool-definition
   break from an expected git-snapshot break; cross-session reuse is handled;
   unsupported explanations and missing prices remain explicit.
5. **Complete Quota (C).** Normalize snapshots, show freshness/reset windows,
   and add qualified forecasts with documented evidence requirements.
   **Check:** missing headers preserve the last observation, resets do not
   create false rates, and sparse/stale data produces no confident forecast.
6. **Complete integration and release verification.** Finish all four sidebar
   links and the persistent seeit workspace. Verify standalone deep links and
   the actual local Open WebUI browser path. Check narrow layouts, keyboard
   use, expired evidence, API outages/recovery, and large paginated sessions.
   **Check:** one frontend serves both access modes, tabs survive chat changes,
   and gateway streaming behavior remains intact.

Use meaningful unit tests for accounting, attribution, cache comparisons,
retention, and forecasts; API tests for filtering/pagination and data states;
and browser checks for the investigation flow in both access modes. Follow
ADR 0005 for provider examples and reviewed fixtures. Run `pnpm typecheck`
and `pnpm test` for implementation changes, including the streaming integration
test when touching the proxy path. Record failures owned by concurrent work
separately; do not modify unrelated changes to make a frontend check pass.
Ledger tests accept a configured PostgreSQL connection so they work with native
or container databases. Add gateway-to-ledger fault tests and verify the proxy
under concurrent recording and dashboard load; an isolated streaming test alone
does not demonstrate that background work cannot delay the hot path.

New runtime dependencies still require approval under the repo rules. Choose
the minimum frontend dependencies needed for the agreed Vite + React stack;
do not add a chart framework, state framework, or component suite by default.

**Outside this release:** Open WebUI conversation ingestion, budget editing
or enforcement, routing controls, retention settings, repo/branch attribution,
subagent trees, full replay, mobile-specific workflows, live token counters,
and remote deployment. These remain in their existing later phases where
applicable. The delivered dashboard interface is read-only; the ledger service
also exposes authenticated recording ingestion to the gateway.

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
