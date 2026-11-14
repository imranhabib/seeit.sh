// The proxy. Data flow for one call:
//
//   harness ──request──▶ gateway ──same bytes──▶ upstream
//   harness ◀──chunk by chunk── tee ◀──stream── upstream
//                                └──copy──▶ recorder (after the stream ends: write JSON file)

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Config } from "./config.ts";
import { redactHeaders } from "./redact.ts";
import { decodeRequestBody, parseResponseBody, readBranch, writeRecording } from "./recorder.ts";

// Hop-by-hop headers belong to one connection and must not be forwarded.
const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-connection"];

export function createApp(config: Config, hooks: { onRecorded?: (file: string) => void } = {}) {
  const app = new Hono();

  app.all("/:harness/*", async (c) => {
    const harness = c.req.param("harness");
    const upstreamBase = config.upstreams[harness];
    if (!upstreamBase) return c.json({ error: `unknown harness "${harness}"` }, 404);

    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const start = performance.now();

    // "/claude/v1/messages?beta=true" -> "https://api.anthropic.com/v1/messages?beta=true"
    const url = new URL(c.req.url);
    const path = url.pathname.slice(harness.length + 1) + url.search;
    const target = upstreamBase + path;

    const reqHeaders = new Headers(c.req.raw.headers);
    for (const h of [...HOP_BY_HOP, "host", "content-length"]) reqHeaders.delete(h);
    // Let fetch pick accept-encoding itself. It then decompresses exactly the
    // encodings it asked for, so the client always receives plain bytes.
    reqHeaders.delete("accept-encoding");

    const method = c.req.method;
    // The request body is small compared with the response, and we need it for
    // the recording, so reading it fully here is fine.
    const reqBody = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method,
        headers: reqHeaders,
        body: reqBody,
        // If the harness disconnects (user pressed Esc), abort upstream too, so
        // the provider stops generating tokens nobody will read.
        signal: c.req.raw.signal,
      });
    } catch (err) {
      console.error(`[${harness}] upstream request failed:`, err);
      return c.json({ error: "upstream request failed" }, 502);
    }
    const timeToResponseHeadersMs = performance.now() - start;

    const resHeaders = new Headers(upstream.headers);
    // fetch already decompressed the body, so these headers would now be wrong.
    for (const h of [...HOP_BY_HOP, "content-encoding", "content-length"]) resHeaders.delete(h);

    const [toClient, toRecorder] = upstream.body ? upstream.body.tee() : [null, null];

    // Not awaited: recording must never delay the response.
    void (async () => {
      const branch = toRecorder ? await readBranch(toRecorder, start) : { text: "", timeToFirstChunkMs: null, aborted: false };
      const file = await writeRecording(config.recordDir, {
        id,
        harness,
        startedAt,
        timings: { timeToResponseHeadersMs, timeToFirstChunkMs: branch.timeToFirstChunkMs, timeToStreamEndMs: performance.now() - start },
        aborted: branch.aborted,
        request: {
          method,
          path,
          headers: redactHeaders(c.req.raw.headers),
          body: reqBody ? decodeRequestBody(reqBody, c.req.header("content-encoding") ?? null) : null,
        },
        response: {
          status: upstream.status,
          headers: redactHeaders(upstream.headers),
          ...parseResponseBody(branch.text, upstream.headers.get("content-type")),
        },
      });
      console.log(`[${harness}] ${method} ${path} -> ${upstream.status} (${Math.round(performance.now() - start)} ms)`);
      hooks.onRecorded?.(file);
    })().catch((err) => console.error(`[${harness}] recording failed:`, err));

      return new Response(toClient, { status: upstream.status, headers: resHeaders });
  });

  return app;
}
