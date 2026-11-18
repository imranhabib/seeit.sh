// The gateway sending calls to the ledger service (ADR 0007), with a fake
// upstream and a fake ledger.

import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { RecordedCall } from "@seeit/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { openLedger, type Ledger } from "../../src/db/ledger.ts";
import { DEFAULT_DELIVERY, createDelivery, type Delivery } from "../../src/delivery.ts";

const EVENT_GAP_MS = 100;
const EVENTS = [
  { type: "message_start", message: { model: "claude-test", usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
];

const upstream: Server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "anthropic-ratelimit-unified-5h-utilization": "0.5" });
  let n = 0;
  const timer = setInterval(() => {
    const e = EVENTS[n]!;
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    if (++n === EVENTS.length) {
      clearInterval(timer);
      res.end();
    }
  }, EVENT_GAP_MS);
});

// The fake ledger stores what it receives, or never answers when hanging.
let hanging = false;
const received: { auth: string | undefined; call: RecordedCall }[] = [];
let onReceived: () => void = () => {};
const ledgerService: Server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (hanging) return; // no answer: the gateway's timeout must end it
    received.push({ auth: req.headers.authorization, call: JSON.parse(body) });
    res.writeHead(201).end('{"status":"stored"}');
    onReceived();
  });
});

let gateway: ReturnType<typeof serve>;
let gatewayUrl = "";
let ledger: Ledger;
let delivery: Delivery;

beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => ledgerService.listen(0, "127.0.0.1", resolve));
  const fake = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const ledgerUrl = `http://127.0.0.1:${(ledgerService.address() as AddressInfo).port}`;
  ledger = openLedger(":memory:");
  delivery = createDelivery({ ...DEFAULT_DELIVERY, url: ledgerUrl, token: "write-token", timeoutMs: 300, maxAttempts: 1 }, { log: () => {} });
  const recordDir = await mkdtemp(join(tmpdir(), "seeit-test-"));
  const app = createApp({ host: "127.0.0.1", port: 0, recordDir, dbPath: ":memory:", upstreams: { claude: fake, codex: fake } }, ledger, {}, delivery);
  await new Promise<void>((resolve) => {
    gateway = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      gatewayUrl = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  gateway?.close();
  for (const server of [upstream, ledgerService]) {
    server.closeAllConnections();
    server.close();
  }
  ledger?.close();
});

const turn = () =>
  fetch(`${gatewayUrl}/claude/v1/messages`, {
    method: "POST",
    headers: { authorization: "Bearer sk-secret", "x-claude-code-session-id": "s1", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-test", tools: [{ name: "Read" }], messages: [{ role: "user", content: "hi" }] }),
  });

describe("delivery to the ledger service", () => {
  it("sends each call as a RecordedCall, with credentials redacted and the pieces covering the body", async () => {
    const arrived = new Promise<void>((resolve) => (onReceived = resolve));
    const text = await (await turn()).text();
    await arrived;
    const { auth, call } = received.at(-1)!;
    expect(auth).toBe("Bearer write-token");
    expect(call).toMatchObject({ harness: "claude", method: "POST", path: "/v1/messages", response: { status: 200 }, clientAborted: false, readFailed: false });
    expect(call.turnId).toEqual(expect.any(String));
    expect(call.request.headers.authorization).toBe("[redacted, 16 chars]");
    expect(call.request.body).toContain('"content":"hi"');
    expect(call.response.headers["anthropic-ratelimit-unified-5h-utilization"]).toBe("0.5");
    expect(call.response.body).toBe(text);
    expect(call.response.pieces.reduce((n, [length]) => n + length, 0)).toBe(text.length);
  });

  // Hot path rule 3: storage never blocks the response.
  it("streams to the client at full speed while the ledger does not answer", async () => {
    hanging = true;
    try {
      const start = performance.now();
      const response = await turn();
      const reader = response.body!.getReader();
      await reader.read();
      const firstChunkAt = performance.now() - start;
      while (!(await reader.read()).done);
      const doneAt = performance.now() - start;
      // The upstream takes about EVENTS.length * EVENT_GAP_MS; the ledger adds nothing.
      expect(firstChunkAt).toBeLessThan(EVENT_GAP_MS * 2);
      expect(doneAt).toBeLessThan(EVENT_GAP_MS * (EVENTS.length + 2));
      await delivery.idle();
      expect(delivery.stats().dropped).toBeGreaterThanOrEqual(1);
    } finally {
      hanging = false;
    }
  });
});
