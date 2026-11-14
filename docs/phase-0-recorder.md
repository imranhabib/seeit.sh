# Phase 0 — Recorder spike

A pass-through proxy that records every call to `data/recordings/<day>/*.json`
(git-ignored). Credential headers are redacted before writing.

## Run it

```bash
pnpm dev                      # gateway on http://127.0.0.1:8787
```

**Claude Code** (subscription login is kept; only the URL changes):

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787/claude claude
```

**Codex** (ChatGPT login is kept; `OPENAI_API_KEY` must be unset). For one run:

```bash
codex -c model_provider=seeit -c 'model_providers.seeit.name="seeit"' -c 'model_providers.seeit.base_url="http://127.0.0.1:8787/codex"' -c 'model_providers.seeit.wire_api="responses"' -c 'model_providers.seeit.requires_openai_auth=true'
```

Or permanently, in `~/.codex/config.toml` (user-level file; Codex ignores
provider settings in project config):

```toml
[model_providers.seeit]
name = "seeit"
base_url = "http://127.0.0.1:8787/codex"
wire_api = "responses"
requires_openai_auth = true

[profiles.seeit]
model_provider = "seeit"
```

then `codex --profile seeit`.

Summarize what was recorded:

```bash
pnpm summarize
```

## Findings (2026-11-13, claude-cli 2.1.322, codex 0.153.4)

Verified with one `claude -p` and one `codex exec` call through the gateway.

### Upstreams and paths

| Harness | Calls seen                                  | Upstream                                |
| ------- | ------------------------------------------- | --------------------------------------- |
| Claude  | `HEAD /api/hello`, `POST /v1/messages?beta=true` | `https://api.anthropic.com` ✅          |
| Codex   | `GET /models`, `POST /responses`            | `https://chatgpt.com/backend-api/codex` ✅ |

Codex printed `Model metadata for <model> not found` with the custom provider.
It still worked. Check in Phase 1 whether `/models` needs special handling.

### Session and turn IDs

- **Claude:** header `x-claude-code-session-id`, also in body
  `metadata.user_id` (a JSON string with `session_id`, `device_id`,
  `account_uuid`). **No explicit turn ID**: turns must be inferred.
- **Codex:** headers `session-id`, `thread-id`, `x-codex-window-id`, and
  `x-codex-turn-metadata` (JSON) with **`turn_id`**, `root_turn_id`,
  `agent_name`, `request_kind`. Turns are explicit. The same JSON is also in
  body `client_metadata`. `prompt_cache_key` equals the session ID.

### Usage

- **Claude:** `usage` in the `message_start` and `message_delta` SSE events.
  Fields: `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, plus a split by cache TTL
  (`ephemeral_5m` / `ephemeral_1h`). The final numbers are in `message_delta`.
- **Codex:** `response.usage` in the final `response.completed` event:
  `input_tokens`, `input_tokens_details.cached_tokens` / `cache_write_tokens`,
  `output_tokens_details.reasoning_tokens`. It also has a **per-field
  `attribution`**: tokens for `tools`, `instructions`, and each input message.
  In the test call, tool definitions were **102,978 of 110,009** input tokens.
  **Update (Codex 0.169.0):** `attribution` was missing, and tools and
  instructions had moved into `input` items (see PLAN.md, Phase 1,
  "Version-tolerant parsing"). Attribution helps when present, but the gateway
  must estimate the breakdown itself for both harnesses.

### Plan-quota headers (feature C is possible)

- **Claude:** `anthropic-ratelimit-unified-5h-utilization`, `-5h-reset`,
  `-7d-utilization`, `-7d-reset`, `-status`, `-representative-claim`.
- **Codex:** `x-codex-primary-used-percent`, `-primary-window-minutes`,
  `-primary-reset-at`, and the same for `secondary`, plus `x-codex-plan-type`
  and `x-codex-active-limit`.

### Gotchas found

1. **The Codex backend sends SSE with no `content-type` header.** Detect SSE
   from the body as well (fixed in the recorder, covered by a test).
2. **Codex closes the connection right after `response.completed`.** The
   gateway passes the disconnect to upstream, so the recording shows
   `aborted: true` even though the response was complete. Phase 1 must decide
   "complete" from the final event (`message_stop` / `response.completed`),
   not from how the connection ended.
3. **Request bodies contain identifiers** (`account_uuid`, `device_id`,
   `installation_id`). Header redaction does not cover them. Redact bodies by
   hand before committing any fixture.
4. Upstream responses are compressed (`content-encoding`). `fetch` decompresses
   them, so the gateway strips `content-encoding` / `content-length` (tested).
