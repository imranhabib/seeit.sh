// Plan-quota response headers from the ChatGPT backend, as Codex receives them
// (PLAN.md, Phase 2).

// Codex header names follow codex-rs/codex-api/src/rate_limits.rs. Besides
// the default "codex" family, the server can send one family per metered
// limit, named after the limit ID: x-<limit_id>-primary-used-percent, ...
// (limit "codex_other" -> x-codex-other-...). The server also sends window
// headers the Codex client does not read (x-codex-primary-reset-after-seconds,
// x-codex-primary-over-secondary-limit-percent, seen live 2026-11-16), so any
// suffix after -primary- / -secondary- is kept. Every pattern needs a quota
// word, so unrelated x-... headers (request IDs, account IDs) are not stored.
export const QUOTA_HEADERS = [
  /^x-[a-z0-9-]+-(primary|secondary)-[a-z0-9-]+$/,
  /^x-[a-z0-9-]+-limit-name$/,
  /^x-codex-credits-(has-credits|unlimited|balance)$/,
  /^x-codex-(plan-type|active-limit|rate-limit-reached-type|promo-message)$/,
];
