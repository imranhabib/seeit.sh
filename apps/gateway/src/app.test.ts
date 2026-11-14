import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import type { Recording } from "./recorder.ts";

const EVENT_GAP_MS = 100;
const EVENTS = 5;

// --- fake upstream -----------------------------------------------------------
let upstreamReqHeaders: IncomingHttpHeaders = {};
let upstreamSawClose = false;

const upstream: Server = createServer((req, res) => {
  upstreamReqHeaders = req.headers;
  if (req.url === "/v1/stream") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let n = 0;
    const timer = setInterval(() => {
      res.write(`event: tick\ndata: {"n":${n}}\n\n`);
      if (++n === EVENTS) {
        clearInterval(timer);
        res.end();
      }
    }, EVENT_GAP_MS);
  } else if (req.url === "/v1/sse-no-content-type") {
    // Like the ChatGPT Codex backend: SSE body, no content-type header.
    res.writeHead(200);
    res.end('event: response.completed\ndata: {"usage":{"input_tokens":1}}\n\n');
  } else if (req.url === "/v1/gzip") {
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end(gzipSync(JSON.stringify({ ok: true })));
  } else if (req.url === "/v1/forever") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const timer = setInterval(() => res.write("data: tick\n\n"), 20);
    res.on("close", () => {
      clearInterval(timer);
      upstreamSawClose = true;
    });
  }
});

// --- gateway -----------------------------------------------------------------
let gatewayUrl = "";
let gateway: ReturnType<typeof serve>;
let recordDir = "";
const recordedWaiters: ((file: string) => void)[] = [];
const nextRecording = () => new Promise<string>((resolve) => recordedWaiters.push(resolve));

beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  recordDir = await mkdtemp(join(tmpdir(), "seeit-test-"));
  const app = createApp(
    { host: "127.0.0.1", port: 0, recordDir, upstreams: { test: `http://127.0.0.1:${upstreamPort}` } },
    { onRecorded: (file) => recordedWaiters.shift()?.(file) },
  );
  await new Promise<void>((resolve) => {
    gateway = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      gatewayUrl = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  gateway?.close();
  upstream.closeAllConnections();
  upstream.close();
});

describe("gateway proxy", () => {
  it("streams chunks to the client before upstream finishes", async () => {
    const recorded = nextRecording();
    const start = performance.now();
    const res = await fetch(`${gatewayUrl}/test/v1/stream`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true }),
    });

    let timeToFirstChunkMs = 0;
    let text = "";
    const decoder = new TextDecoder();
    for await (const chunk of res.body!) {
      timeToFirstChunkMs ||= performance.now() - start;
      text += decoder.decode(chunk, { stream: true });
    }
    const timeToStreamEndMs = performance.now() - start;

    // Upstream needs ~EVENTS * EVENT_GAP_MS. A buffering proxy would deliver
    // the first chunk only at the end.
    expect(timeToStreamEndMs).toBeGreaterThanOrEqual((EVENTS - 1) * EVENT_GAP_MS);
    expect(timeToFirstChunkMs).toBeLessThan(EVENT_GAP_MS * 2.5);
    expect(text.match(/event: tick/g)).toHaveLength(EVENTS);

    // Credentials pass through to upstream...
    expect(upstreamReqHeaders.authorization).toBe("Bearer secret-token");

    // ...but never reach the recording.
    const rec: Recording = JSON.parse(await readFile(await recorded, "utf8"));
    expect(rec.request.headers.authorization).toMatch(/^\[redacted/);
    expect(JSON.stringify(rec)).not.toContain("secret-token");
    expect(rec.request.body).toEqual({ model: "m", stream: true });
    expect(rec.response.events).toHaveLength(EVENTS);
    expect(rec.response.events![0]).toEqual({ event: "tick", data: { n: 0 } });
  });

  it("records an SSE body that has no content-type header as events", async () => {
    const recorded = nextRecording();
    await (await fetch(`${gatewayUrl}/test/v1/sse-no-content-type`)).text();
    const rec: Recording = JSON.parse(await readFile(await recorded, "utf8"));
    expect(rec.response.events).toEqual([{ event: "response.completed", data: { usage: { input_tokens: 1 } } }]);
  });

  it("returns a decompressed body without a content-encoding header", async () => {
    const recorded = nextRecording();
    const res = await fetch(`${gatewayUrl}/test/v1/gzip`);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
    await recorded;
  });

  it("aborts the upstream request when the client disconnects", async () => {
    const controller = new AbortController();
    const res = await fetch(`${gatewayUrl}/test/v1/forever`, { signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();

    const deadline = Date.now() + 2000;
    while (!upstreamSawClose && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(upstreamSawClose).toBe(true);
  });

  it("returns 404 for an unknown harness", async () => {
    const res = await fetch(`${gatewayUrl}/nope/v1/messages`);
    expect(res.status).toBe(404);
  });
});
