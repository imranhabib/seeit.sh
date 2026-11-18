# 0009 — Ledger data model: sessions, turns, tool uses, compactions

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
```

- **Tokens stay only on `calls`.** Session and turn totals are sums over
  `calls` (a view if convenient). Stored totals would have to follow every
  late call and recompute (ADR 0008).
- **`tool_uses` stores labels, never content.** Tool inputs and results follow
  body retention. Only these input fields are read, because they are labels:
  Claude Code `Skill.skill` and `Agent.subagent_type`. Any other field must be
  added to this list on purpose.
- **Plugins are a column, not a table.** A plugin is not an event; it supplies
  skills, MCP servers, and agents, and is read from their names.
- **Compaction is a property of a call.** The compaction request is one call,
  so its trigger is stored on that call.
- **Hooks are not in this model.** They run inside the harness; see ADR 0010.

### Where each fact comes from

| Fact | Claude Code | Codex |
| --- | --- | --- |
| Built-in tool | `tool_use` block `name` (`Bash`, `Edit`, ...) | `function_call` / `custom_tool_call` `name` in namespace `functions` (`exec`, `wait`, ...). Since 0.169 the tool list is an `additional_tools` input item made of namespaces. |
| MCP tool | Name `mcp__<server>__<tool>` | Its own namespace, named after the server. It can carry the `mcp__` prefix and a hash suffix (`codex-mcp/src/tools.rs`). Not yet seen live. |
| Skill | A `Skill` tool call, input `skill` | No tool call. Explicit use (`$skill` in the prompt) injects the skill file into the request; implicit use is the model reading a `SKILL.md` with `exec` (`core/src/skills.rs`). Not yet seen live. |
| Subagent | An `Agent` tool call, input `subagent_type`; the subagent's calls carry `x-claude-code-agent-id` (and `x-claude-code-agent-type` with hint headers) | A `spawn_agent` call in namespace `collaboration`; the subagent's calls carry their own `turn_id`, and `root_turn_id` names the user's turn |
| Server tool | `server_tool_use` blocks and `usage.server_tool_use` | `web_search_call` output items |
| Plugin | `plugin:skill` skill names; `mcp__plugin_<plugin>_<server>__…` tool names | Codex tracks a skill's `plugin_id` internally; whether it reaches the request is not yet known |
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

Iris has a manual compaction scenario only for Claude Code and an automatic
one only for Codex. Before this model is trusted, add:

- Claude Code automatic compaction, and Codex manual compaction.
- Claude Code runs with `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`.
- An MCP tool, a skill, and a plugin, for each harness, with a sandbox MCP
  server and skill (the user's own are kept out, see `apps/iris`).
