# 0001 — Intercept with a base-URL reverse proxy

**Status:** accepted

## Decision

Each harness is pointed at the gateway with its base-URL setting
(`ANTHROPIC_BASE_URL` for Claude Code, a custom `model_providers` entry for
Codex). The gateway forwards requests to the real upstream. Each harness gets a
path prefix (`/claude`, `/codex`) that identifies it and selects the upstream.

## Why

- No TLS interception: no local CA certificate, no problems with certificate
  pinning, Node's CA store, or HTTP/2.
- Both harnesses support it with subscription auth. The OAuth token passes
  through in `Authorization`; the gateway forwards it unchanged.

## Rejected

- **MITM HTTPS proxy** (`HTTPS_PROXY` + local CA): catches everything but is
  fragile. Keep only as a fallback for a harness with no base-URL setting.
- **Harness detection from `User-Agent`**: fragile. The path prefix is
  explicit. `User-Agent` is still recorded to track harness versions.

## Consequences

- The gateway must forward `Authorization` and `anthropic-beta` unchanged.
- Any gateway credential must go in a custom header, never `Authorization`.
