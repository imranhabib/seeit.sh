# 0009 — Ledger data model: sessions, turns, tool uses, compactions, quota

**Status:** accepted; implemented 2026-11-18 (migration `0002`), except tool durations (see below)

## Context

The PostgreSQL ledger (ADR 0007) has two tables: `calls` (one row per call,
kept forever) and `bodies` (gzipped request and response, then deleted after
14 days; retention was removed on 2026-11-18). Sessions and turns exist only
as ID columns on `calls`. ADR 0008 makes
turns something the ledger assigns and recomputes, which needs session and
turn state. The dashboard also needs which tools, skills, subagents, and MCP
servers a session used, and when the conversation was compacted, after the
bodies that hold those facts have expired.

The facts below were checked for both harnesses: Claude Code 2.1.326 (its
session transcripts and the
[gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol)),
and Codex 0.169.1 (Iris recordings of 2026-11-17 and the open-source client,
`openai/codex` at commit `1c2e4cd`, `codex-rs/`).

## Decision

### Tables

```
users      PK id                         seeit's own user ID; 'local' by default
           created_at

sessions   PK (user_id, harness, id)     session IDs come from the harness
           user_id → users
           harness_version, first_call_at, last_call_at
           last_started_at, last_seq     ADR 0008: is a new call in order?
           settled_at                    ADR 0008: null while provisional

turns      PK id                         harness turn ID, or the ID of the call that started it
           (user_id, harness, session_id) → sessions
           started_by_call_id → calls, started_at
           source                        'harness' | 'inferred'

calls      PK id (gateway UUID)          all existing columns stay, plus:
           user_id → users               not null: every call belongs to a user
           (user_id, harness, session_id) → sessions   nullable session: connectivity checks have none
           turn_id → turns                     nullable
           seq                           ADR 0008
           provider_request_id           Anthropic request-id / OpenAI resp_…; join key to
                                         Claude Code transcripts and OpenTelemetry events
           compaction_trigger            'auto' | 'manual' | 'reactive'; null when not a compaction
           compaction_reason             Codex only, for example 'context_limit'

body_pieces  PK (user_id, harness, scope, hash)   each distinct request piece, stored once
           scope                         the session ID; the call ID when the call has no session
           hash                          sha256 of the piece without cache_control markers
           gz                            the gzipped piece
           bytes, first_seen_at

call_pieces  PK (call_id, ordinal)       the request as a recipe: its pieces in order
           call_id → calls
           path                          'tools', 'system', 'messages[3]', 'input[2]', 'fields'
           hash → body_pieces            (with the call's user_id, harness, scope)
           cache_control                 the marker that was on this piece; null if none

bodies     PK call_id                    the response only; request_gz is no longer written
                                         (calls stored before this keep their request there)
           created_at, response_gz

tool_uses  PK (call_id, tool_use_id)
           call_id → calls               the call whose response asked for the tool
           kind                          'builtin' | 'mcp' | 'skill' | 'agent' | 'server'
           name                          tool name as sent
           namespace                     Codex tool namespace; null for Claude Code
           target                        skill name, subagent type, or MCP server
           plugin                        when it can be read from the names; else null
           duration_ms                   when the harness reports it; else null (not read yet:
                                         Claude Code's header lists durations by tool name,
                                         "ToolSearch=3", not by tool use ID)
           result_chars                  size of the result in the next request

quota_windows  PK (call_id, window)       one row per plan-quota window a response reported
           call_id → calls
           harness, observed_at          the call's started_at
           window                        Claude Code: '5h' | '7d' (and others it sends);
                                         Codex: 'primary' | 'secondary', or '<limit_id>-primary' ...
           used_percent                  0-100 (Claude Code sends 0-1 utilization; ×100)
           resets_at                     Claude Code: <window>-reset; Codex: <window>-reset-at
           window_minutes                Codex only (x-codex-<window>-window-minutes)
           status                        Claude Code only ('allowed', ...)
```

- **Every row belongs to a user** (decided 2026-11-18), so the data model
  is ready for more than one person from the start. No sign-in or
  permissions yet:
  - `users` is seeit's own user list. It does not come from provider
    accounts: one person can have several (a Claude plan and a ChatGPT
    plan), and the account-ID headers are redacted before they leave the
    gateway.
  - The gateway sends a `userId` in every `RecordedCall`, from its setting
    `SEEIT_USER_ID` (default `'local'`). The ledger creates the `users` row
    the first time it sees an ID. Until there is sign-in, the ledger trusts
    the value it is sent; later, a per-user write token decides the user
    instead.
  - `calls` and `sessions` carry `user_id`, and it is part of every session
    key. Tables reached through a call (`tool_uses`, `context_parts`,
    `quota_windows`, `call_pieces`, `bodies`) take the user from that call.
    `body_pieces` and `model_catalog` carry it themselves.
  - Plan quota belongs to a provider account, not to a seeit user. With one
    account per user it is shown per user; a `provider_accounts` table comes
    when one user needs several.
- **Request bodies are stored once per piece, per session** (decided
  2026-11-18). Each request is cut into pieces (Claude Code: `tools`,
  `system`, each message, the other fields; Codex: each input item and the
  other fields), and each distinct piece is stored once per
  `(user_id, harness, session)`. A request is kept as its recipe in
  `call_pieces`. Every request repeats the session's history, so this keeps
  the history once instead of once per call (2026-11-18 estimate from one
  week of the owner's traffic: about 3 GB for 30 days as whole requests,
  0.2-0.5 GB as pieces).
  - **Why per session and not global:** the same piece still has the same
    hash in every session, but each session keeps its own copy. That costs
    about 13 KB per session (the tools, system prompt, and environment that
    every session repeats; about 1 MB per week). In return, deleting a
    session or expiring its calls never has to check other sessions, and
    one user's pieces are never shared with another user's.
  - **Cache markers are removed before hashing** and kept on the
    `call_pieces` row. Claude Code moves `cache_control` to the newest
    message on every call, which would otherwise change an old message's
    hash (seen in Iris: `messages[2]` differed only by its marker).
  - **A rebuilt request matches in content, not byte for byte** (key order
    and spacing can differ). The gateway still forwards the original bytes;
    only storage is affected.
  - **No retention for now** (decided 2026-11-18): pieces, recipes, and
    responses are kept. If retention returns, it deletes recipes and
    responses older than the period, then each session's pieces that no
    remaining recipe in that session uses.
  - **Responses stay whole**, one per call: each one is new text.
- **Tokens stay only on `calls`.** Session and turn totals are sums over
  `calls` (a view if convenient). Stored totals would have to follow every
  late call and recompute (ADR 0008).
- **`tool_uses` stores labels, never content.** Tool inputs and results stay
  in the bodies. Only these inputs are read, for labels: Claude Code
  `Skill.skill` and `Agent.subagent_type`, and the tool names called from
  Codex `exec` code (`tools.<name>(`; see below). Any other field must be
  added to this list on purpose.
- **Codex calls most tools from code.** Since 0.169 (code mode) the model
  writes JavaScript for the `exec` tool, and that code calls the real tools:
  `await tools.exec_command({...})`, `await tools.mcp__iris__echo({...})`.
  At the response level these are all one `exec` call. The ledger reads the
  tool names from the code, one `tool_uses` row per `tools.<name>(` call
  (ID `<call_id>#<n>`), plus one row for the `exec` call itself, which gets
  the result size (seen live 2026-11-18, Iris `codex-mcp`).
- **Plugins are a column, not a table.** A plugin is not an event; it supplies
  skills, MCP servers, and agents, and is read from their names.
- **Quota is kept twice: raw and normalized.** `calls.quota` keeps every
  quota header as sent (both harnesses send them on every turn call). The
  ledger also writes one `quota_windows` row per window, in one shape for
  both harnesses, for budget charts and forecasts (`/api/quota`, Phase 2).
  Plan-level facts (Claude Code fallback and overage, Codex plan type,
  credits, active limit) stay in `calls.quota`.
- **Compaction is a property of a call.** The compaction request is one call,
  so its trigger is stored on that call.
- **Hooks are not in this model.** They run inside the harness; see ADR 0010.

### Context parts, caching, and compaction detail

Added 2026-11-18 for feature I (PLAN.md, Phase 2), from the field inventory
of that day (PLAN.md, Phase 1 follow-ups). These are facts the bodies hold
but that must outlive the bodies if body retention returns.

```
context_parts  PK (call_id, ordinal)     one row per part of the prompt
           call_id → calls
           ordinal                       order in the cached prefix: Claude tools → system →
                                         messages; Codex input order
           item_id                       Codex input item ID (attribution key); null for Claude
           part                          content part index in the item; null for the whole item
           section                       'tools' | 'system' | 'messages' | 'input'
           role                          'system' | 'developer' | 'user' | 'assistant' | null
           category                      fixed list in PLAN.md feature I (system_prompt,
                                         tool_definitions, deferred_tools, instructions_global,
                                         instructions_project, environment, skills, plugins, mcp,
                                         permissions, collaboration, multi_agent, hook_output,
                                         compaction_summary, user_prompt, assistant, tool_call,
                                         tool_result, reasoning, subagent_message, other)
           label                         safe name: 'tool:Bash', 'instructions:project'; never a
                                         path or content
           chars
           input_tokens, cached_tokens, cache_write_tokens
           tokens_source                 'provider' | 'breakpoint' | 'estimated'
           breakpoint_ttl                Claude: '5m' | '1h' when a cache breakpoint ends this
                                         part; else null
           analysis_version

model_catalog  PK (user_id, harness, harness_version, model)   Codex GET /models; one row per model;
                                         harness_version is the client_version query parameter
                                         when the user-agent names no Codex version
           user_id → users               the catalog can depend on the account's plan
           call_id → calls               the /models call it was read from
           observed_at
           context_window, max_context_window, auto_compact_token_limit
           comp_hash                     compaction prompt version
           truncation_mode, truncation_limit
           tool_mode                     'code_mode_only', ...
           base_instructions_chars, base_instructions_sha256   detects a changed base prompt
```

New `calls` columns (null when the harness does not send the field):

| Column | Harness | Source |
| --- | --- | --- |
| `cache_ttl` | Claude | The lifetime the breakpoints ask for: `'5m'` (no `ttl`) or `'1h'` |
| `cache_write_30m_tokens`, `cache_write_12h_tokens` | Codex | `input_tokens_details.cache_write_tokens_details` |
| `prompt_cache_retention` | Codex | `response.prompt_cache_retention` (`'24h'`) |
| `context_edits` (jsonb) | Claude | `context_management.applied_edits`; `[]` = checked, nothing removed |
| `cache_miss_reason` (jsonb) | Claude | `message_start` `message.diagnostics.cache_miss_reason` (`{type, cache_missed_input_tokens}`); null when not sent |
| `usage_iterations` (jsonb) | Claude | `usage.iterations`, the per-attempt usage |
| `request_kind` | Codex | Turn metadata `request_kind`, as sent |
| `context_window_number`, `history_initialization` | Codex | Turn metadata `window_number`, `history_initialization` |
| `compaction_phase`, `compaction_strategy` | Codex | Turn metadata `compaction.phase`, `compaction.strategy` |
| `harness_turn_started_at` | Codex | Turn metadata `turn_started_at_unix_ms` (ADR 0008 ordering) |
| `harness_build`, `entrypoint` | Claude | `system[0]` billing block: `cc_version`, `cc_entrypoint` |
| `retry_count` | Claude | `x-stainless-retry-count` |
| `reasoning_effort` | both | Claude `output_config.effort`; Codex `reasoning.effort` |
| `thinking_type` | Claude | `thinking.type` |
| `service_tier`, `inference_geo` | both / Claude | Usage `service_tier`; Claude `inference_geo` |
| `features` (jsonb) | both | Claude `anthropic-beta` list; Codex `x-codex-beta-features` |

- **Codex parts are exact; Claude parts are estimates with anchors.** Codex
  `usage.attribution.items` gives input, cached, and cache-write tokens per
  item and per content part. Its keys are item IDs, sorted by ID, so parts
  are matched by `item_id`, never by position. Claude Code reports totals
  only: its parts get `estimated` counts (characters ÷ 2.8 for now; a ratio
  per kind of content comes when Iris checks them). The breakpoints still
  give each part's cache state: the read ends at a breakpoint, the write
  runs from there to the last breakpoint, and everything after the last
  breakpoint is uncached. A stretch with only one part gets the provider's
  exact total for that stretch (`breakpoint`). The difference between the
  parts and the reported total is shown, never spread over the parts. (On
  the first Iris runs, 2026-11-18, the Claude parts summed to 99-100% of the
  reported input.)
- **One row per part, on every model call.** The same part repeats on every
  call of a session; that is what shows the context growing and the cache
  state of each part over time. Rows grow with calls × parts (a 200-call
  session with about 150 parts per call is about 30,000 rows). If that
  becomes too large, keep the per-part rows for a limited period and
  per-category totals for good.
- **Compaction effects are derived, not stored here.** Context before and
  after, cost, tokens saved per later call, and break-even come from the
  calls on each side of the compaction call, as Phase 2 derived
  measurements.
- **Session-file facts are not in this migration.** A later, optional
  importer (PLAN.md, Phase 2) adds facts that only the harnesses' session
  files hold, such as Claude Code `compactMetadata`, to calls already
  stored, matched by `provider_request_id`. Its columns come with it.
- **Codex `prompt_cache_key` is not stored.** It equals the session ID (181
  of 181 calls), so it adds nothing.

### Where each fact comes from

| Fact | Claude Code | Codex |
| --- | --- | --- |
| Built-in tool | `tool_use` block `name` (`Bash`, `Edit`, ...) | `custom_tool_call` `exec`, whose code calls `tools.exec_command(...)` and other tools; `function_call` with a `namespace` for the rest (`collaboration/spawn_agent`). The tool list is an `additional_tools` input item made of namespaces. |
| MCP tool | Name `mcp__<server>__<tool>` | Same name, called from `exec` code: `tools.mcp__<server>__<tool>(...)` (seen live) |
| Skill | A `Skill` tool call, input `skill` | No tool call. Explicit use (`$skill` in the prompt) injects the skill file into the request (seen live); implicit use is the model reading a `SKILL.md` with `exec_command` (`core/src/skills.rs`). |
| Subagent | An `Agent` tool call, input `subagent_type`; the subagent's calls carry `x-claude-code-agent-id` (and `x-claude-code-agent-type` with hint headers) | A `spawn_agent` call in namespace `collaboration`; the subagent's calls carry their own `turn_id`, and `root_turn_id` names the user's turn |
| Server tool | `server_tool_use` blocks and `usage.server_tool_use` | `web_search_call` output items |
| Plugin | `plugin:skill` skill names; `mcp__plugin_<plugin>_<server>__…` tool names | A plugin's skill is read from `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/skills/` (seen live), so the path names the plugin; no plugin field in the request |
| Tool duration | `x-claude-code-prev-tool-durations` (hint headers) | None known |
| Tool result size | `tool_result` in the next request | `function_call_output` / `custom_tool_call_output` in the next request |
| Compaction, manual | `x-claude-code-compaction: manual` (hint headers) | `x-codex-turn-metadata`: `request_kind: "compaction"`, `compaction.trigger: "manual"` |
| Compaction, auto | `x-claude-code-compaction: auto` | Same, `trigger: "auto"`, `reason: "context_limit"` (seen live) |
| Compaction, other | `reactive` (the API rejected the request as too long) | `reason`: `user_requested`, `context_limit`, `model_downshift`, `comp_hash_changed` (`analytics/src/facts.rs`) |
| First call after a compaction | `x-claude-code-context-compacted` | `window_number` in the turn metadata goes up |
| Compaction without hint headers | Not identified: the `/compact` call counts as a turn today | Always sent |

## Consequences

- One new migration in `apps/ledger` (`0002`). Calls stored before it are
  put under the user `local`, with sessions and turns built from them.
- Claude Code compaction and tool duration depend on
  `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` (ADR 0008). Without it,
  `compaction_trigger` stays null for Claude Code.
- **Compaction calls are `background` for both harnesses.** The user did not
  ask for a model answer, so a compaction is not a turn; it is linked to the
  turn in progress like other background calls. Codex calls are already
  `background`. Claude Code's `/compact` call counts as a turn today; it
  becomes `background` when `x-claude-code-compaction` is present (hint
  headers on), and the `claude-compaction` Iris scenario's expected turn
  count changes with it. Without hint headers it cannot be told apart and
  stays a turn.
- Codex's turn metadata also holds workspace paths, the git commit hash, and
  `installation_id`. They must not reach stored data unredacted (Iris
  finding 13 covers `installation_id` in fixtures only).
- Codex marks prewarm and memory requests (`request_kind`: `prewarm`,
  `memory`). Their kind should be checked when parsing moves.

### Verification gaps (Iris, both harnesses)

Iris scenarios cover each source for both harnesses: manual and automatic
compaction (`claude-compaction`, `codex-manual-compaction`,
`codex-compaction`), an MCP tool (`claude-mcp`,
`codex-mcp`), a skill (`claude-skill`, `codex-skill`), and a plugin
(`claude-plugin`, `codex-plugin`), with Iris's own MCP server, skill, and
plugins (`apps/iris/fixtures`). Claude Code runs with
`CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`. Codex manual compaction runs through
`codex app-server` (`thread/compact/start`), because `codex exec` has no
`/compact`.

One gap remains: Claude Code automatic compaction (`x-claude-code-compaction:
auto`) is documented but not seen live. Claude Code 2.1.326 in `-p` mode did
not compact at 41,000 tokens with `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000` and
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=30`, in separate steps or in one tool loop
(2026-11-18), nor at 96,000 tokens with `autoCompactWindow: 100000`. Reaching
the default window costs too much quota for a routine scenario.
