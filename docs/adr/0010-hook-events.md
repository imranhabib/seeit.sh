# 0010 — Recording hook events

**Status:** proposed; to be filled in

## Context

Hooks run inside the harness on the user's machine. The gateway sees only
their effect: text a hook adds to the prompt, or a tool result changed or
blocked by a hook. No request names the hook or its event, so hook use cannot
be recorded from traffic alone (ADR 0009 leaves hooks out of the data model).

What each harness offers, checked 2026-11-17:

| | Claude Code 2.1.326 | Codex 0.169.1 |
| --- | --- | --- |
| Configuration | `hooks` in settings files | `hooks.json` in `.codex/`, same format; runs only in a trusted project with trusted hooks |
| Handler types | command, and HTTP (the hook input is the POST body) | command and prompt (`codex-rs/hooks/src/declarations.rs`); no HTTP handler |
| Input every hook gets | `session_id`, `prompt_id`, `transcript_path`, `cwd`, `hook_event_name`, and per-event fields | Per-event input (not yet listed here) |
| Events | 33, including `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `PreCompact`, `Stop`, `SessionEnd` | Including `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `PreCompact`, `PostCompact`, `PreModelRequest`, `PostModelRequest` |
| Seen in traffic | Hook output as prompt text (the transcript marks it locally as `hook_system_message`) | `UserPromptSubmit` stdout added to the prompt (PLAN.md, Iris finding 11) |

## Options

1. **Do not record hooks.** Note the gap in the dashboard.
2. **Hooks report to the ledger.** A hook sends its event to a ledger
   endpoint: an HTTP hook in Claude Code; a small command in Codex, which has
   no HTTP handler. This adds a second data source next to the gateway.
3. **Infer from traffic.** Detect hook text in prompts. Fragile: the text has
   no fixed marker in either harness.

## Open questions

- Which hook facts matter: which hooks ran, how long they took, how many
  tokens their output added to prompts, or blocks and denials?
- Authentication and setup for a second ingestion source, and whether it
  follows ADR 0007's delivery rules.
- How hook events join calls: `session_id` and `prompt_id` (Claude Code),
  `turn_id` (Codex).
- Whether OpenTelemetry events from the harnesses are a better source than
  hooks.

## Decision

Not yet decided.
