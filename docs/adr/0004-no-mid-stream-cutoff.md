# 0004 — Budgets block before the request, never mid-stream

**Status:** accepted

## Decision

Budget limits are checked only before a request is sent upstream. A response
stream that has started is always allowed to finish. A blocked request gets an
error in the provider's own format (for example an Anthropic-style `429` error
body) so the harness shows it correctly.

## Why

- Cutting a stream corrupts the harness's conversation state.
- The tokens for that call are already spent when the stream starts.
- The output size of a call cannot be known before it runs, so a limit can be
  exceeded by at most one call. This is accepted.

## Consequences

- Budget counters are in memory and updated when each call's usage is parsed.
  The ledger rebuilds them on startup.
- A warning is logged at 80% of a limit. Harnesses cannot show custom warnings.
- A gateway block looks the same as an upstream `429` to the harness. To tell
  them apart, every gateway block carries the header `x-seeit-blocked: budget`,
  and the ledger records whether `upstream` or `gateway` blocked the call.
