# 0009 — Ledger data model: sessions, turns, tool uses, compactions, quota

**Status:** accepted; implementation pending

## Context

The PostgreSQL ledger (ADR 0007) has two tables: `calls` (one row per call,
kept forever) and `bodies` (gzipped request and response, deleted after 14
days). Sessions and turns exist only as ID columns on `calls`. ADR 0008 makes
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
sessions   PK (harness, id)              session IDs come from the harness
           harness_version, first_call_at, last_call_at
           last_started_at, last_seq     ADR 0008: is a new call in order?
           settled_at                    ADR 0008: null while provisional

turns      PK id                         harness turn ID, or the ID of the call that started it
           (harness, session_id) → sessions
           started_by_call_id → calls, started_at
           source                        'harness' | 'inferred'

calls      PK id (gateway UUID)          all existing columns stay, plus:
           (harness, session_id) → sessions   nullable: connectivity checks have no session
           turn_id → turns                     nullable
           seq                           ADR 0008
           provider_request_id           Anthropic request-id / OpenAI resp_…; join key to
                                         Claude Code transcripts and OpenTelemetry events
           compaction_trigger            'auto' | 'manual' | 'reactive'; null when not a compaction
           compaction_reason             Codex only, for example 'context_limit'

bodies     unchanged

tool_uses  PK (call_id, tool_use_id)
           call_id → calls               the call whose response asked for the tool
           kind                          'builtin' | 'mcp' | 'skill' | 'agent' | 'server'
           name                          tool name as sent
           namespace                     Codex tool namespace; null for Claude Code
           target                        skill name, subagent type, or MCP server
           plugin                        when it can be read from the names; else null
           duration_ms                   when the harness reports it; else null
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

- **Tokens stay only on `calls`.** Session and turn totals are sums over
  `calls` (a view if convenient). Stored totals would have to follow every
  late call and recompute (ADR 0008).
- **`tool_uses` stores labels, never content.** Tool inputs and results follow
  body retention. Only these inputs are read, for labels: Claude Code
  `Skill.skill` and `Agent.subagent_type`, and the tool names called from
  Codex `exec` code (`tools.<name>(`; see below). Any other field must be
  added to this list on purpose.
- **Codex calls most tools from code.** Since 0.169 (code mode) the model
  writes JavaScript for the `exec` tool, and that code calls the real tools:
  `await tools.exec_command({...})`, `await tools.mcp__iris__echo({...})`.
  At the response level these are all one `exec` call. The ledger reads the
  tool names from the code, one `tool_uses` row per `tools.<name>(` call
  (seen live 2026-11-18, Iris `codex-mcp`).
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

- One new migration in `apps/ledger`. The gateway's SQLite schema is retired
  at cutover (ADR 0007) and does not get these tables; the schema-match test
  in `apps/ledger/src/db/schema.test.ts` must allow the PostgreSQL-only tables.
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
