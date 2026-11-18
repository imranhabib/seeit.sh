// Header rules for forwarding a call. Bodies are forwarded as raw bytes and
// never touched here.

// Hop-by-hop headers belong to one connection and must not be forwarded.
const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-connection"];

/** The harness's request headers, made ready to send upstream. */
export function upstreamRequestHeaders(incoming: Headers): Headers {
  const headers = new Headers(incoming);
  for (const h of [...HOP_BY_HOP, "host", "content-length"]) headers.delete(h);
  // Let fetch pick accept-encoding itself. It then decompresses exactly the
  // encodings it asked for, so the client always receives plain bytes.
  headers.delete("accept-encoding");
  return headers;
}

/** The upstream response headers, made ready to send to the harness. */
export function clientResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream);
  // fetch already decompressed the body, so these headers would now be wrong.
  for (const h of [...HOP_BY_HOP, "content-encoding", "content-length"]) headers.delete(h);
  return headers;
}
