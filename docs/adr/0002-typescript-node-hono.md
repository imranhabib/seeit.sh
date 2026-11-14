# 0002 — TypeScript on Node with Hono

**Status:** accepted

## Decision

Write the gateway in TypeScript on Node 24 LTS with Hono and the web-standard
`fetch` / `ReadableStream` APIs.

## Why

- The owner reads TypeScript and Python, not Go or Rust. LLMs write most of the
  code, so the owner must be able to **review** it line by line.
- Language speed does not matter: model latency (seconds) is about 1000× larger
  than proxy overhead. Performance comes from design (streaming, teeing, async
  storage), not from the language.
- `ReadableStream.tee()` makes the stream-to-client / copy-to-parser split
  explicit and easy to read.

## Rejected

- **Go**: the classic proxy language, but the owner cannot review it yet.
- **Python (FastAPI + httpx)**: readable, but asyncio streaming and
  backpressure are easier to get subtly wrong.
- **Rust**: slowest to iterate.

## Consequences

- Official SDKs (`@anthropic-ai/sdk`, `openai`) may be used for **types only**,
  never to send upstream requests. The gateway forwards raw bytes and decodes
  only the fields it needs.
