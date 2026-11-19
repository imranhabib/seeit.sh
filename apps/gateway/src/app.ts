// The proxy. Data flow for one call:
//
//   harness ──request──▶ gateway ──same bytes──▶ upstream
//   harness ◀──chunk by chunk── tee ◀──stream── upstream
//                                └──copy──▶ observe (parse events, usage, timings)
//                                             └─▶ ledger row + gzipped bodies (+ JSON recording)
//
// Everything after the tee runs in the background. The hot path is only:
// read request bytes → fetch → tee → return the client stream.

import { randomUUID } from "node:crypto";
import type { Harness } from "@seeit/core";
import { Hono } from "hono";
import type { Config } from "./config.ts";
import type { Delivery } from "./delivery.ts";
import { clientResponseHeaders, upstreamRequestHeaders } from "./forward.ts";
import { createCallRecorder, type Hooks } from "./record-call.ts";

export function createApp(config: Config, hooks: Hooks = {}, delivery?: Delivery) {
  const app = new Hono();
  const recordCall = createCallRecorder(config, hooks, delivery);

  app.all("/:harness/*", async (c) => {
    const harness = c.req.param("harness") as Harness;
    const upstreamBase = config.upstreams[harness];
    if (!upstreamBase) return c.json({ error: `unknown harness "${harness}"` }, 404);

    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const start = performance.now();

    // "/claude/v1/messages?beta=true" -> "https://api.anthropic.com/v1/messages?beta=true"
    const url = new URL(c.req.url);
    const path = url.pathname.slice(harness.length + 1) + url.search;

    const method = c.req.method;
    // The request body is small compared with the response, and we need it for
    // analysis, so reading it fully here is fine.
    const reqBody = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();

    let upstream: Response | null = null;
    let fetchError: unknown = null;
    try {
      upstream = await fetch(upstreamBase + path, {
        method,
        headers: upstreamRequestHeaders(c.req.raw.headers),
        body: reqBody,
        // If the harness disconnects (user pressed Esc), abort upstream too, so
        // the provider stops generating tokens nobody will read.
        signal: c.req.raw.signal,
      });
    } catch (err) {
      fetchError = err;
    }
    const timeToResponseHeadersMs = performance.now() - start;

    const [toClient, toObserver] = upstream?.body ? upstream.body.tee() : [null, null];

    // Not awaited: analysis and storage must never delay the response.
    void recordCall({
      id,
      startedAt,
      start,
      harness,
      method,
      path,
      requestHeaders: c.req.raw.headers,
      requestBody: reqBody,
      signal: c.req.raw.signal,
      upstream,
      responseStream: toObserver,
      timeToResponseHeadersMs,
    }).catch((err) => console.error(`[${harness}] recording failed:`, err));

    if (!upstream) {
      if (!c.req.raw.signal.aborted) console.error(`[${harness}] upstream request failed:`, fetchError);
      return c.json({ error: "upstream request failed" }, 502);
    }
    return new Response(toClient, { status: upstream.status, headers: clientResponseHeaders(upstream.headers) });
  });

  return app;
}
