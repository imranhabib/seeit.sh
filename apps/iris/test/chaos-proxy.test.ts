import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startChaosProxy, type ChaosProxy, type ProxyEvent } from "../src/chaos-proxy.ts";

// A fake provider: an Anthropic-shaped stream, one event every 20 ms.
const EVENTS = [
  { type: "message_start", message: { usage: { input_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "one " } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "two " } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "three" } },
  { type: "message_stop" },
];
let seenHeaders: IncomingHttpHeaders = {};
let seenBody = "";
let sawClose = false;

const provider: Server = createServer((req, res) => {
  seenHeaders = req.headers;
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seenBody = body;
    if (req.url === "/v1/plain") {
      res.writeHead(201, { "x-custom": "yes" }).end("plain body");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    let n = 0;
    const timer = setInterval(() => {
      const e = EVENTS[n]!;
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      if (++n === EVENTS.length) {
        clearInterval(timer);
        res.end();
      }
    }, 20);
    res.on("close", () => {
      clearInterval(timer);
      sawClose = true;
    });
  });
});

let proxy: ChaosProxy;
beforeAll(async () => {
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const fake = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  proxy = await startChaosProxy({ claude: fake, codex: fake }, { "hook-note": "Project note" });
});
afterAll(async () => {
  await proxy.close();
  provider.closeAllConnections();
  provider.close();
});

// A Claude Code turn: POST /v1/messages with a client tool (see readRequest in @seeit/core).
const turn = (body: object = { tools: [{ name: "Read" }], messages: [{ role: "user", content: "hi" }] }) =>
  fetch(`${proxy.url}/claude/v1/messages`, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function record() {
  const events: ProxyEvent[] = [];
  const stop = proxy.onEvent((e) => events.push(e));
  return { events, types: () => events.map((e) => e.type), stop };
}

describe("chaos proxy", () => {
  it("forwards method, path, headers, and body unchanged, and returns status and headers", async () => {
    const res = await fetch(`${proxy.url}/codex/v1/plain`, { method: "POST", headers: { authorization: "Bearer t" }, body: "hello" });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-custom")).toBe("yes");
    expect(await res.text()).toBe("plain body");
    expect(seenHeaders.authorization).toBe("Bearer t");
    expect(seenBody).toBe("hello");
  });

  it("passes a whole stream through and observes what it held", async () => {
    const { events, types, stop } = record();
    const text = await (await turn()).text();
    stop();
    expect(text).toContain("message_stop");
    expect(types()).toEqual(["start", "end"]);
    expect(events.at(-1)!.call).toMatchObject({ harness: "claude", kind: "turn", stream: true, final: true });
    expect(events.at(-1)!.call.markers).toMatchObject({ "path:/v1/messages": 1, "block:thinking": 1, "block:text": 1, "delta:text_delta": 3, "delta:thinking_delta": 1, "event:message_stop": 1 });
  });

  it("marks a request that holds a configured needle", async () => {
    const { events, stop } = record();
    await (await turn({ tools: [{ name: "Read" }], messages: [{ role: "user", content: "Project note: use 2 spaces" }] })).text();
    stop();
    expect(events.at(-1)!.call.markers["request:hook-note"]).toBe(1);
  });

  it("cuts a turn stream after the given number of text deltas, delivering them first", async () => {
    sawClose = false;
    proxy.armNextTurn("claude", { afterTextDeltas: 2, cut: true });
    const { events, types, stop } = record();
    const res = await turn();
    // Read what arrives until the connection drops.
    let received = "";
    const decoder = new TextDecoder();
    await expect(
      (async () => {
        for await (const chunk of res.body!) received += decoder.decode(chunk, { stream: true });
      })(),
    ).rejects.toThrow();
    stop();
    // The empty thinking delta does not count; both text deltas arrived.
    expect(received).toContain("two ");
    expect(received).not.toContain("three");
    expect(types()).toEqual(["start", "threshold", "cut"]);
    expect(events.at(-1)!.call).toMatchObject({ stream: true, final: false });
    // The provider is told to stop as well.
    await expect.poll(() => sawClose).toBe(true);
    // Only one stream is cut.
    expect(await (await turn()).text()).toContain("message_stop");
  });

  it("only reports the threshold when the plan does not cut", async () => {
    proxy.armNextTurn("claude", { afterTextDeltas: 1, cut: false });
    const { types, stop } = record();
    expect(await (await turn()).text()).toContain("message_stop");
    stop();
    expect(types()).toEqual(["start", "threshold", "end"]);
  });

  it("keeps the plan for the next turn when a background stream comes first", async () => {
    proxy.armNextTurn("claude", { afterTextDeltas: 1, cut: true });
    // No client tool: a side request (see readRequest).
    expect(await (await turn({ tools: [], messages: [{ role: "user", content: "title" }] })).text()).toContain("message_stop");
    await expect((await turn()).text()).rejects.toThrow();
  });

  it("reports a stream the client left as not final", async () => {
    const { events, stop } = record();
    const controller = new AbortController();
    const res = await fetch(`${proxy.url}/claude/v1/messages`, { method: "POST", body: JSON.stringify({ tools: [{ name: "Read" }], messages: [] }), signal: controller.signal });
    await res.body!.getReader().read();
    controller.abort();
    await expect.poll(() => events.at(-1)?.type).toBe("end");
    stop();
    expect(events.at(-1)!.call.final).toBe(false);
  });

  // Codex names each request's purpose in x-codex-turn-metadata (seen live:
  // "turn", "compaction").
  it("marks the Codex request kind", async () => {
    const { events, stop } = record();
    const headers = { "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction", session_id: "s" }) };
    await (await fetch(`${proxy.url}/codex/v1/plain`, { method: "POST", headers, body: "{}" })).text();
    stop();
    expect(events.at(-1)!.call.markers["request-kind:compaction"]).toBe(1);
  });

  it("returns 404 for an unknown harness", async () => {
    expect((await fetch(`${proxy.url}/nope/v1/messages`)).status).toBe(404);
  });
});
