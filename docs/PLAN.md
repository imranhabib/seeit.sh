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
- **Runs:** locally first (`127.0.0.1`), later on a private server reached over
  Tailscale.

## Architecture

```
 claude ──ANTHROPIC_BASE_URL──▶ ┌──────────────────────────────┐ ──▶ api.anthropic.com
                               │  gateway  /claude/*  /codex/* │
 codex ───provider base_url───▶ │                              │ ──▶ chatgpt.com/backend-api/codex
                               └──────┬───────────────────────┘
                                      │ tee (off the hot path)
                                      ▼
                         parser ─▶ SQLite ledger ─▶ dashboard (A, B, C, E)
                                └▶ OTel traces  ─▶ Langfuse
```

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
- **SQLite ledger** ([ADR 0003](adr/0003-sqlite-ledger-plus-langfuse.md)): one
  row per call with harness, session, turn, model, input / output / cache-read /
  cache-write tokens, estimated cost, latency. It is the source of truth for
  budgets and the custom dashboard.
- **Timings per call** (milliseconds from when the gateway received the
  request, measured with the monotonic `performance.now()` clock):
  - `timeToResponseHeadersMs`: upstream status and headers arrived. Network,
    auth, and queueing. The ChatGPT backend sends headers only when the model
    is ready, so for Codex this already includes model time.
  - `timeToFirstChunkMs`: first body chunk arrived. Usually a metadata event
    (`message_start`), not answer text.
  - `timeToFirstTokenMs` (Phase 1): first answer delta arrived
    (`content_block_delta` / `response.output_text.delta`). The real time to
    first token.
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
  them before any write.
- Bind to `127.0.0.1` locally.
- Server deployment: no public port. Reach it over Tailscale and require a
  gateway token in a custom header (`ANTHROPIC_CUSTOM_HEADERS` for Claude Code,
  `env_http_headers` for Codex).
- Stored bodies contain code and possibly secrets. Keep the data directory on an
  encrypted disk.

### Operations

- Runs as a `launchd` service. If the gateway is down, the harnesses fail
  (fail-closed). This is on purpose: budgets must not be easy to bypass.
- Emergency bypass: unset `ANTHROPIC_BASE_URL` / switch the Codex profile.
- A gateway restart cuts every stream in progress. In development, `pnpm dev`
  (`tsx watch`) restarts on every file save, so do not edit gateway code while
  a harness session you care about runs through it.
- On a server, any reverse proxy in front of the gateway must not close idle
  connections during long model pauses (for example nginx closes after 60 s of
  no data by default). Raise its read timeout and turn off response buffering.

## Stack

TypeScript on Node 24 LTS with Hono ([ADR 0002](adr/0002-typescript-node-hono.md)).

```
apps/gateway      Hono proxy server
apps/dashboard    Vite + React custom dashboard (Phase 2)
packages/core     shared parsers, schema, pricing
infra/            Docker Compose for Langfuse, launchd plist
docs/             this plan, ADRs
```

SQLite through `better-sqlite3` with Drizzle (Phase 1). Tests with Vitest.

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

- **Replace the hand-written SSE parser with `eventsource-parser`** (runtime
  dependency approved). The Phase 0 parser in `packages/core/src/sse.ts` was
  written to learn how SSE framing works; a maintained, spec-compliant library
  covers edge cases ours misses (lone `\r` line endings, a byte-order mark,
  `id` / `retry` fields, not dispatching an event that has no `data`).
  - Use `EventSourceParserStream` on the recorder branch:
    `body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream())`.
  - Keep the existing tests (whole stream, 1/2/3/7/13-character chunks) and
    run them against the library first, as proof it fits. Then delete
    `sse.ts`.
  - Decide how to handle an unfinished last event at end of stream. The spec
    says to drop it; our parser returns it. For truncated calls (see
    *Completion status per call*) keeping it may help the output-token
    estimate.
- Per-provider event interpreters on top of the parser: Anthropic Messages
  (`message_start` … `message_stop`) and OpenAI Responses
  (`response.created` … `response.completed`).
- Usage extraction, session and turn detection.
- Call-kind classification: `turn` vs `background` (connectivity checks, quota
  probes).
- `timeToFirstTokenMs` timing and the derived prefill time and output tokens per
  second (see *Timings per call*).
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
- SQLite ledger and gzipped body storage.
- Streaming integration test (first byte before upstream finishes).

### Phase 2 — Observability

- OTel export to Langfuse (Docker Compose).
- Custom dashboard: A, B, C, E.
- Quota tracking (C) uses only responses that carry quota headers. Responses
  without them (for example an upstream `429` with no
  `anthropic-ratelimit-unified-*` headers) are skipped, not read as zero.

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
