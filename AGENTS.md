# AGENTS.md

Instructions for coding agents (Codex, Claude Code, others) working in this
repo. `CLAUDE.md` imports this file, so keep all shared rules here.

## What this project is

seeit.sh is a single-user AI gateway. It proxies Claude Code and Codex traffic
to their providers, records usage, and shows where tokens go. Read
[docs/PLAN.md](docs/PLAN.md) before larger changes. Key decisions are in
[docs/adr/](docs/adr/). If a change conflicts with an ADR, stop and ask; do not
silently work around it.

The owner is using this project to learn how a gateway works. Prefer clear,
readable code over clever code. Add a short comment where a line exists for a
non-obvious reason (a protocol detail, a performance rule).

## Layout

```
apps/gateway     Hono proxy server (TypeScript, Node 24)
packages/core    shared parsers and helpers, imported as @seeit/core
docs/            plan and ADRs
data/            local recordings and databases (git-ignored, never commit)
```

Do not name a directory `lib/`: the root `.gitignore` ignores it.

## Commands

```bash
pnpm install          # install dependencies
pnpm test             # run all tests (Vitest)
pnpm typecheck        # tsc --noEmit for all packages
pnpm dev              # run the gateway on 127.0.0.1:8787
pnpm summarize        # summarize recordings in data/recordings
pnpm --filter @seeit/gateway db:generate   # new SQL migration after a schema change
```

Run `pnpm typecheck` and `pnpm test` before you say a change is done.

The ledger schema is `apps/gateway/src/db/schema.ts`. After changing it, run
`db:generate` and commit the new file in `apps/gateway/drizzle/`. Never edit a
migration that is already committed; add a new one.

## Hot path rules (do not break these)

The request/response path between harness and upstream is performance
critical:

1. **Stream, never buffer the response.** Pass each upstream chunk to the
   client when it arrives. Never `await response.text()` on the client path.
2. **Tee the stream.** The parser/recorder reads its own branch of
   `body.tee()`. It must never slow the client branch.
3. **Storage never blocks the response.** Write after the stream ends, without
   awaiting it on the client path.
4. **Forward raw bytes.** Do not parse and re-serialize request or response
   bodies. Decode only the fields you need.
5. **Strip `content-encoding` and `content-length` from upstream response
   headers.** `fetch` decompresses the body, so these headers become wrong.
6. **Never cut off a stream mid-way** (ADR 0004). Budget checks happen before
   the upstream request.

## Security rules

- Never write `Authorization`, cookies, API keys, or account-ID headers to
  disk or logs. Use the redaction helper in `apps/gateway/src/redact.ts`.
- Bind to `127.0.0.1` by default.
- Never commit anything from `data/`. Test fixtures in the repo must be
  reviewed and redacted by hand first.

## Code style

- TypeScript strict mode, ES modules, no build step (run with `tsx`).
- Small modules with plain functions. No classes unless state requires it.
- Keep dependencies few. Ask before adding a new runtime dependency.
- Use the official provider SDKs for types only, never to send requests.

## Testing

- Vitest. Tests sit next to the code as `*.test.ts`.
- Parser tests use recorded SSE fixtures. Feed them in small, odd-sized chunks
  so chunk-boundary bugs show up.
- Any change to the proxy path must keep the streaming test passing (first
  chunk reaches the client before upstream finishes).
