// How a call ended. Decided from the events, not from how the connection
// ended: Codex closes the connection right after its final event, so a
// closed connection alone does not mean a truncated stream (PLAN.md,
// "Completion status per call").

export type Completion = "complete" | "upstream_error" | "client_aborted" | "upstream_dropped" | "gateway_error";

export function decideCompletion(c: {
  /** HTTP status from upstream, or null if the request never got a response. */
  status: number | null;
  isStream: boolean;
  final: boolean;
  errorType: string | null;
  clientAborted: boolean;
  readFailed: boolean;
  gatewayFailed: boolean;
}): Completion {
  if (c.gatewayFailed) return "gateway_error";
  if (c.final) return "complete";
  if (c.errorType || (c.status !== null && c.status >= 400)) return "upstream_error";
  if (c.clientAborted) return "client_aborted";
  if (c.status === null || c.readFailed) return "upstream_dropped";
  // A non-streaming body that was read to the end is complete. A stream that
  // ended without its final event was cut by upstream.
  return c.isStream ? "upstream_dropped" : "complete";
}
