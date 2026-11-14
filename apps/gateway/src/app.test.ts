import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { openLedger, type Ledger } from "./db/ledger.ts";
import { bodies, type CallRow } from "./db/schema.ts";
import type { Recording } from "./recorder.ts";

const EVENT_GAP_MS = 100;

// Anthropic-shaped stream, one event every EVENT_GAP_MS.
const CLAUDE_EVENTS = [
  { type: "message_start", message: { model: "claude-test", usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 1 } } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
];

// --- fake upstream -----------------------------------------------------------
let upstreamReqHeaders: IncomingHttpHeaders = {};
let upstreamSawClose = false;

const upstream: Server = createServer((req, res) => {
  upstreamReqHeaders = req.headers;
  if (req.url === "/v1/forever" || req.url === "/v1/messages?forever=1") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const timer = setInterval(() => res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"tick "}}\n\n'), 20);
    res.on("close", () => {
      clearInterval(timer);
      upstreamSawClose = true;
    });
  } else if (req.url?.startsWith("/v1/messages")) {
    res.writeHead(200, { "content-type": "text/event-stream", "anthropic-ratelimit-unified-5h-utilization": "0.25" });
    let n = 0;
    const timer = setInterval(() => {
      const e = CLAUDE_EVENTS[n]!;
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      if (++n === CLAUDE_EVENTS.length) {
        clearInterval(timer);
        res.end();
      }
    }, EVENT_GAP_MS);
  } else if (req.url === "/responses") {
    // Like the ChatGPT Codex backend: SSE body, no content-type header.
    res.writeHead(200);
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"pong"}\n\n');
    res.end(
      'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-test","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":40},"output_tokens":2}}}\n\n',
    );
  } else if (req.url === "/v1/gzip") {
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end(gzipSync(JSON.stringify({ ok: true })));
  }
});

// --- gateway -----------------------------------------------------------------
let gatewayUrl = "";
let gateway: ReturnType<typeof serve>;
let ledger: Ledger;
// Rows are written in the background, possibly after the test that caused them
// has finished, so each waiter matches on method and path.
let callWaiters: { method: string; path: string; resolve: (row: CallRow) => void }[] = [];
const nextCall = (method: string, path: string) => new Promise<CallRow>((resolve) => callWaiters.push({ method, path, resolve }));
const onCall = (row: CallRow) => {
  const waiter = callWaiters.find((w) => w.method === row.method && w.path === row.path);
  callWaiters = callWaiters.filter((w) => w !== waiter);
  waiter?.resolve(row);
};
const recordedWaiters: ((file: string) => void)[] = [];
const nextRecording = () => new Promise<string>((resolve) => recordedWaiters.push(resolve));

beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const fake = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const recordDir = await mkdtemp(join(tmpdir(), "seeit-test-"));
  ledger = openLedger(":memory:");
  const app = createApp({ host: "127.0.0.1", port: 0, recordDir, dbPath: ":memory:", upstreams: { claude: fake, codex: fake } }, ledger, {
    onCall,
    onRecorded: (file) => recordedWaiters.shift()?.(file),
  });
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
  ledger?.close();
});

const claudeTurn = { model: "claude-test", tools: [{ name: "Read" }], messages: [{ role: "user", content: "hi" }] };

describe("gateway proxy", () => {
  it("streams chunks to the client before upstream finishes", async () => {
    const start = performance.now();
    const res = await fetch(`${gatewayUrl}/claude/v1/messages?beta=true`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
      body: JSON.stringify(claudeTurn),
    });

    let timeToFirstChunkMs = 0;
    let text = "";
    const decoder = new TextDecoder();
    for await (const chunk of res.body!) {
      timeToFirstChunkMs ||= performance.now() - start;
      text += decoder.decode(chunk, { stream: true });
    }
    const timeToStreamEndMs = performance.now() - start;

    // Upstream needs ~5 * EVENT_GAP_MS. A buffering proxy would deliver the
    // first chunk only at the end.
    expect(timeToStreamEndMs).toBeGreaterThanOrEqual((CLAUDE_EVENTS.length - 1) * EVENT_GAP_MS);
    expect(timeToFirstChunkMs).toBeLessThan(EVENT_GAP_MS * 2.5);
    expect(text).toContain("message_stop");
    expect(upstreamReqHeaders.authorization).toBe("Bearer secret-token");
  });

  it("returns a decompressed body without a content-encoding header", async () => {
    const res = await fetch(`${gatewayUrl}/claude/v1/gzip`);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
  });

  it("aborts the upstream request when the client disconnects", async () => {
    const call = nextCall("GET", "/v1/forever");
    const controller = new AbortController();
    const res = await fetch(`${gatewayUrl}/claude/v1/forever`, { signal: controller.signal });
    await res.body!.getReader().read();
    controller.abort();

    const deadline = Date.now() + 2000;
    while (!upstreamSawClose && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(upstreamSawClose).toBe(true);
    expect((await call).completion).toBe("client_aborted");
  });

  it("returns 404 for an unknown harness", async () => {
    const res = await fetch(`${gatewayUrl}/nope/v1/messages`);
    expect(res.status).toBe(404);
  });
});

describe("ledger", () => {
  it("records a complete Claude turn with usage, timings, quota, and bodies", async () => {
    const call = nextCall("POST", "/v1/messages?beta=true");
    const recorded = nextRecording();
    await (
      await fetch(`${gatewayUrl}/claude/v1/messages?beta=true`, {
        method: "POST",
        headers: { authorization: "Bearer secret-token", "x-claude-code-session-id": "sess-1", "user-agent": "claude-cli/9.9.9 (test)" },
        body: JSON.stringify(claudeTurn),
      })
    ).text();
    const row = await call;

    expect(row).toMatchObject({
      harness: "claude",
      harnessVersion: "claude-cli/9.9.9",
      sessionId: "sess-1",
      kind: "turn",
      completion: "complete",
      model: "claude-test",
      httpStatus: 200,
      inputTokens: 10,
      cacheReadTokens: 900,
      cacheWriteTokens: 50,
      outputTokens: 3,
      tokensEstimated: false,
      toolsCount: 1,
    });
    expect(row.turnId).toBeTruthy();
    // first text delta is the 2nd event, so it arrives after the first chunk
    expect(row.timeToFirstTokenMs!).toBeGreaterThan(row.timeToFirstChunkMs!);
    expect(JSON.parse(row.quota!)).toEqual({ "anthropic-ratelimit-unified-5h-utilization": "0.25" });

    const [stored] = ledger.db.select().from(bodies).where(eq(bodies.callId, row.id)).all();
    expect(JSON.parse(gunzipSync(stored!.requestGz!).toString())).toEqual(claudeTurn);
    expect(gunzipSync(stored!.responseGz!).toString()).toContain("message_stop");

    // Credentials never reach the recording.
    const rec: Recording = JSON.parse(await readFile(await recorded, "utf8"));
    expect(rec.request.headers.authorization).toMatch(/^\[redacted/);
    expect(JSON.stringify(rec)).not.toContain("secret-token");
  });

  it("keeps the turn for a tool result and starts a new one for new user text", async () => {
    const send = async (messages: object[]) => {
      const call = nextCall("POST", "/v1/messages");
      await (
        await fetch(`${gatewayUrl}/claude/v1/messages`, {
          method: "POST",
          headers: { "x-claude-code-session-id": "sess-2" },
          body: JSON.stringify({ tools: [{ name: "Read" }], messages }),
        })
      ).text();
      return (await call).turnId;
    };
    const first = await send([{ role: "user", content: "read a file" }]);
    const toolLoop = await send([{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }] }]);
    const next = await send([{ role: "user", content: "thanks, now another" }]);
    expect(toolLoop).toBe(first);
    expect(next).not.toBe(first);
  });

  it("records a Codex call whose SSE has no content-type, converting cached input", async () => {
    const call = nextCall("POST", "/responses");
    await (
      await fetch(`${gatewayUrl}/codex/responses`, {
        method: "POST",
        headers: { "session-id": "c-1", "x-codex-turn-metadata": JSON.stringify({ turn_id: "turn-7", request_kind: "turn" }) },
        body: JSON.stringify({ model: "gpt-test", input: [] }),
      })
    ).text();
    expect(await call).toMatchObject({
      completion: "complete",
      turnId: "turn-7",
      model: "gpt-test",
      inputTokens: 60, // 100 total - 40 cached
      cacheReadTokens: 40,
      outputTokens: 2,
    });
  });

  it("estimates usage for a cut stream", async () => {
    const call = nextCall("POST", "/v1/messages?forever=1");
    const controller = new AbortController();
    const res = await fetch(`${gatewayUrl}/claude/v1/messages?forever=1`, {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({ tools: [{ name: "Read" }], messages: [{ role: "user", content: "go" }] }),
    });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.read();
    controller.abort();
    const row = await call;
    expect(row).toMatchObject({ completion: "client_aborted", tokensEstimated: true });
    expect(row.inputTokens).toBeGreaterThan(0);
  });
});
