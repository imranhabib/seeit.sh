// Credentials pass through the gateway unchanged, but must never reach disk
// or logs. Match on header names so new credential headers are caught too.
// Account identifiers count as well: "organization" covers Anthropic's
// anthropic-organization-id response header. "turn-state" is an opaque value
// the ChatGPT backend issues and Codex sends back; the gateway has no use for
// it, so it is not kept.
const SENSITIVE = /authorization|cookie|api-key|token|secret|account|organization|password|turn-state/i;

export function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name] = SENSITIVE.test(name) ? `[redacted, ${value.length} chars]` : value;
  });
  return out;
}
