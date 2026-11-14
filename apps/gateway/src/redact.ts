// Credentials pass through the gateway unchanged, but must never reach disk
// or logs. Match on header names so new credential headers are caught too.
const SENSITIVE = /authorization|cookie|api-key|token|secret|account|password/i;

export function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name] = SENSITIVE.test(name) ? `[redacted, ${value.length} chars]` : value;
  });
  return out;
}
