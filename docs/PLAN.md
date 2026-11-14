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
| `seeit sql "<select>"` | Read-only escape hatch for any other question | 1 |
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

- **The CLI reads through the gateway's read API, not the SQLite file.** The
  gateway will later run on a private server, where the ledger is not on the
  laptop. The Phase 2 dashboard needs the same API, so both share it. The
  first CLI commands bring the first read endpoints; the dashboard extends
  them. Write an ADR for this before building the CLI.
- **`seeit sql` is the exception.** It opens the local database read-only and
  is never exposed over the network: raw SQL over HTTP is risk with no benefit.
- **`seeit fixture` keeps the hand review.** It writes to a file and prints a
  reminder that the repo is public; it never writes into the test folders
  itself.
- **No new dependency for argument parsing.** Use Node's built-in
  `util.parseArgs`.
- **Developer tasks stay in the `justfile`** (`just reset`, `just test`). The
  CLI is for operating and inspecting the gateway, not for working on its
  code.
- **Build order:** `calls`, `call`, `sessions`, `session`, `sql` first. They
  replace `q()` right away. The rest arrive with the phase that adds their
  data.

## Stack

TypeScript on Node 24 LTS with Hono ([ADR 0002](adr/0002-typescript-node-hono.md)).

```
apps/gateway      Hono proxy server
apps/dashboard    Vite + React custom dashboard (Phase 2)
apps/cli          `seeit` command (see *CLI*)
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
   block marks each model boundary, and the final `message_delta` carries the
   serving model in `input_transformations`. The interpreter takes `model` only
   from `message_start`, so after a fallback the ledger records the wrong model
   and cost uses the wrong price. Fix: read the serving model from the final
   `message_delta` when present. Test with an example built from the docs (a
   fallback cannot be triggered on demand).
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
   delta. Decide the definition (first delta of any kind, or first delta with
   text) and document it in *Timings per call*.
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
     quota regex misses per-limit headers (`x-codex-<limit>-primary-*`),
     `x-codex-rate-limit-reached-type`, and `x-codex-promo-message`; usage
     field `codex_rollout_budget_units` is not read.
2. **Spec-derived tests (layer 1)** for the five streaming gaps above, plus
   several `message_delta` events and mid-stream errors. Each test links its
   source (docs page, SDK type, or Codex source file at a pinned commit).
3. **Typed field access.** Add `@anthropic-ai/sdk` as a dev dependency and type
   the fields the interpreter reads with its beta types
   (`BetaRawMessageStreamEvent`, `BetaMessageDeltaUsage`). For Codex, write
   small local types for the fields read, with links to the matching Codex
   source. Keep parsing fail-soft: every field optional. A missing usage field
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
   recent commit messages). Decide the subagent rule here (same
   turn, child turn, or separate), which feeds feature F. Also record whether
   current Claude Code still sends a session-title request in an interactive
   session (finding 2).
5. **Flagged calls become fixtures (layer 4).** Let `make-fixture` read a call
   from the ledger by ID (bodies are kept 14 days), so a call flagged in step 1
   can become a reviewed regression test.
6. **Better output estimate for cut streams.** Replace the 4-characters-per-
   token rule with a tokenizer count of the received text, as LiteLLM does in
   `_recover_interrupted_stream_output_tokens`. The 4-character rule is rough,
   and code and non-English text tokenize differently from prose.

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

### Phase 2 — Observability

- Pinned price file and estimated USD cost per call (moved from Phase 1).
  Price 5-minute and 1-hour cache writes separately (live finding 6).
- OTel export to Langfuse (Docker Compose).
- Custom dashboard: A, B, C, E.
- Extend the gateway read API (started with the CLI) for the dashboard.
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
