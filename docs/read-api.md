# Read API: first slice

The gateway serves JSON metadata at `http://127.0.0.1:8787/api` by default.
Only completed recording writes are visible; this is not an in-flight feed.
The dashboard and CLI will share these endpoints (ADR 0006).

## List calls

`GET /api/calls` returns `{ "calls": [...], "nextOffset": number | null }`.

| Parameter | Meaning | Default |
| --- | --- | --- |
| `limit` | Integer from 1 to 100. | 50 |
| `offset` | Non-negative safe integer. | 0 |
| `harness` | `claude` or `codex`. | Both |
| `session` | Exact, nonempty session ID. Combine with harness to disambiguate. | All, including unassigned calls |
| `kind` | `turn`, `background`, or `connectivity`. | All |

Filters combine with AND. Calls are ordered newest first by `startedAt`, then
ID descending to break timestamp ties. Follow `nextOffset` with the same
filters and limit; null means no further rows were found. New calls can shift
offset pages. Restart at offset 0 when refreshing; this is not snapshot
pagination. Empty results return 200 with an empty list and null next offset.

## Inspect one call

`GET /api/calls/:id` returns `{ "call": {...} }`. A missing call returns
404 with `{ "error": "call not found" }`.

Both endpoints expose the same metadata fields:

- Identity: `id`, `startedAt` (UTC ISO timestamp), `harness`, `harnessVersion`,
  `sessionId`, `turnId`, `kind`, and `model`.
- Result: `httpStatus`, `completion`, and `errorType`.
- Usage: `inputTokens` (uncached input), `cacheReadTokens`, `cacheWriteTokens`,
  `outputTokens`, `reasoningTokens`, and `tokensEstimated`.
- Timing: `timeToResponseHeadersMs`, `timeToFirstChunkMs`,
  `timeToFirstTokenMs`, and `timeToStreamEndMs`, in milliseconds from request
  receipt. First-token timing reflects the existing parser's delta detection;
  it is not guaranteed to mean first visible answer text.
- Prompt size: `toolsCount`, `toolsChars`, and `instructionsChars`. Character
  counts are not token counts.

Nullable values stay null. Null means unknown or unavailable, not zero.
`tokensEstimated` is the stored parser flag. Missing usage subfields in some
existing parser paths currently become zero without that flag; the API cannot
recover their original meaning. Parser fixes and coverage reporting are
separate work. Do not present this first API as a complete accuracy guarantee.

Total input is uncached input + cache reads + cache writes when all are known.
Reasoning tokens are already included in output tokens. Do not add them again.
No aggregate, composition estimate, pricing, or quota forecast is added here.

Invalid listed filter/pagination values return 400 with `{ "error": "..." }`.
HEAD is supported with the corresponding GET status/headers and no body.
Unknown API paths and unsupported methods return 404 and never reach the
provider proxy. Responses use `Cache-Control: no-store`. They do not include
request/response bodies, request URLs, or raw quota headers. There is no write
or SQL endpoint, and no new authentication mechanism in this local-only slice.

## Walkthrough and local checks

1. `apps/gateway/src/read-api.ts` owns the routes and explicit metadata
   selection. The queries read the existing calls table through Drizzle.
   Fetching one extra row determines whether another page exists without
   counting the entire table.
2. `apps/gateway/src/app.ts` mounts `/api` before `/:harness/*`. The read API's
   final catch-all keeps unknown routes and write methods out of the proxy.
3. `apps/gateway/src/read-api.test.ts` seeds synthetic rows in an in-memory
   ledger and exercises the actual app routes. Nothing reads personal data.

Run from the implementation worktree:

```bash
pnpm typecheck
pnpm test
pnpm exec vitest run apps/gateway/src/read-api.test.ts
```

To try HTTP without touching a live gateway or its database, start a separate
instance with a temporary data directory and a different port. Start it without
watch mode so code edits cannot restart it:

```bash
demo_dir=$(mktemp -d)
SEEIT_PORT=8788 SEEIT_DB="$demo_dir/seeit.db" SEEIT_RECORD_DIR="$demo_dir/recordings" pnpm --filter @seeit/gateway exec tsx src/index.ts
```

In another terminal:

```bash
curl -sS -i http://127.0.0.1:8788/api/calls
curl -sS -i 'http://127.0.0.1:8788/api/calls?limit=0'
curl -sS -i http://127.0.0.1:8788/api/calls/missing
curl -sS -i -X POST http://127.0.0.1:8788/api/calls
```

Expect 200 with an empty list, 400, 404, and 404 respectively. Stop the demo
with Ctrl+C. Use the synthetic tests for populated lists, filters, pagination,
metadata privacy, and null/zero/estimate behavior; no live provider request is
needed. The full test suite also verifies first-chunk streaming.
