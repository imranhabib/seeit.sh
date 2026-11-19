// An upstream proxy for Iris runs.
//
//   harness ──▶ gateway ──▶ chaos proxy ──▶ provider
//
// The gateway's upstream URLs point here instead of at the providers
// (SEEIT_CLAUDE_UPSTREAM / SEEIT_CODEX_UPSTREAM). The proxy:
//
// - forwards every request and response unchanged;
// - observes each call on its own, without the gateway: which event, block,
//   and item types the response held and whether its final event arrived.
//   Iris compares this with what the gateway recorded;
// - can act on one turn stream after a number of answer-text deltas: cut the
//   connection (a dropped stream), or only report it (so Iris can interrupt
//   the harness at a known point).
//
// Fault injection lives here, not in the gateway: the gateway must never cut
// a stream (ADR 0004). Like the gateway, the proxy never logs headers or bodies.

import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { createSseParser, readRequest, type CallKind, type Harness } from "@seeit/core";

/** What the proxy saw in one call. */
export type Observed = {
  harness: Harness;
  method: string;
  path: string;
  kind: CallKind;
  /** The response was an event stream (at least one event arrived). */
  stream: boolean;
  /** The provider's final event arrived (message_stop / response.completed). */
  final: boolean;
  /**
   * Counts of what the call contained, for example "event:message_start",
   * "block:thinking", "delta:text_delta" (Anthropic), "item:web_search_call"
   * (OpenAI), "path:/alpha/search" (the request path, without its query),
   * "request-kind:compaction" and "compaction-trigger:manual" (Codex's
   * x-codex-turn-metadata), "hint:compaction:auto" (Claude Code's gateway
   * hint headers, see HINT_HEADERS), "tool:Bash" or
   * "tool:collaboration/spawn_agent" (a tool the response calls, with the
   * Codex namespace), "exec-tool:mcp__iris__echo" (a tool Codex calls from
   * code in its exec tool), and "request:<name>" for each configured needle
   * found in the request body.
   */
  markers: Record<string, number>;
};

export type ProxyEvent = { type: "start" | "threshold" | "cut" | "end"; call: Observed };

export type TurnPlan = {
  /** Act when this many answer-text deltas have passed through. */
  afterTextDeltas: number;
  /** true: cut the connection there. false: only emit "threshold". */
  cut: boolean;
};

export type ChaosProxy = {
  /** Base URL, for example http://127.0.0.1:53211. A harness's upstream is `${url}/${harness}`. */
  url: string;
  /** Apply a plan to the next turn stream of this harness (once). */
  armNextTurn(harness: Harness, plan: TurnPlan): void;
  /** Listen to call events; returns a function that stops listening. */
  onEvent(listener: (e: ProxyEvent) => void): () => void;
  close(): Promise<void>;
};

// Hop-by-hop headers belong to one connection. accept-encoding is dropped so
// fetch picks it and decompresses; content-encoding/length are then wrong.
const SKIP_REQUEST = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length", "accept-encoding"]);
const SKIP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"]);

// Claude Code's gateway hint headers (CLAUDE_CODE_GATEWAY_HINT_HEADERS=1),
// marked as "hint:<name>:<value>". The prompt ID is random, so only its
// presence is marked ("hint:prompt-id").
// https://code.claude.com/docs/en/llm-gateway-protocol#gateway-hint-headers
const HINT_HEADERS = ["compaction", "context-compacted", "request-class", "agent-type"];

export async function startChaosProxy(
  upstreams: Record<Harness, string>,
  /** name -> text (or pattern) to look for in request bodies; found ones become "request:<name>" markers. */
  needles: Record<string, string | RegExp> = {},
): Promise<ChaosProxy> {
  const listeners = new Set<(e: ProxyEvent) => void>();
  const armed = new Map<Harness, TurnPlan>();
  const emit = (type: ProxyEvent["type"], call: Observed) => listeners.forEach((l) => l({ type, call }));

  const server = createServer(async (req, res) => {
    // "/claude/v1/messages?beta=true" -> harness "claude", path "/v1/messages?beta=true"
    const match = req.url?.match(/^\/(claude|codex)(\/.*)?$/);
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    const harness = match[1] as Harness;
    const path = match[2] ?? "";
    const method = req.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || SKIP_REQUEST.has(name)) continue;
      for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
    }
    const bodyText = body?.toString("utf8") ?? "";
    const call: Observed = {
      harness,
      method,
      path,
      kind: readRequest(harness, { method, path, headers, body: parseJson(bodyText) }).kind,
      stream: false,
      final: false,
      markers: {},
    };
    const mark = (key: string) => (call.markers[key] = (call.markers[key] ?? 0) + 1);
    mark(`path:${path.split("?")[0]}`);
    const turnMeta = parseJson(headers.get("x-codex-turn-metadata") ?? "");
    if (isObject(turnMeta) && typeof turnMeta.request_kind === "string") mark(`request-kind:${turnMeta.request_kind}`);
    if (isObject(turnMeta) && isObject(turnMeta.compaction)) mark(`compaction-trigger:${turnMeta.compaction.trigger}`);
    for (const name of HINT_HEADERS) {
      const value = headers.get(`x-claude-code-${name}`);
      if (value) mark(`hint:${name}:${value}`);
    }
    if (headers.has("x-claude-code-prompt-id")) mark("hint:prompt-id");
    for (const [name, text] of Object.entries(needles)) {
      if (typeof text === "string" ? bodyText.includes(text) : text.test(bodyText)) mark(`request:${name}`);
    }
    emit("start", call);

    // If the gateway goes away, stop the provider too.
    const upstreamAbort = new AbortController();
    res.on("close", () => upstreamAbort.abort());

    let upstream: Response;
    try {
      // Forward the exact request bytes (fetch's types want a plain Uint8Array, not a Buffer).
      const bytes = body ? new Uint8Array(body) : undefined;
      upstream = await fetch(upstreams[harness] + path, { method, headers, body: bytes, signal: upstreamAbort.signal });
    } catch {
      if (!res.headersSent) res.writeHead(502);
      res.end();
      emit("end", call);
      return;
    }

    const out: Record<string, string | string[]> = {};
    upstream.headers.forEach((value, name) => {
      if (!SKIP_RESPONSE.has(name) && name !== "set-cookie") out[name] = value;
    });
    const cookies = upstream.headers.getSetCookie();
    if (cookies.length) out["set-cookie"] = cookies;
    res.writeHead(upstream.status, out);

    if (!upstream.body) {
      res.end();
      emit("end", call);
      return;
    }

    // Only a turn stream takes the plan, so a side request cannot use it up.
    const plan = call.kind === "turn" ? armed.get(harness) : undefined;
    if (plan) armed.delete(harness);
    const decoder = new TextDecoder();
    const parser = createSseParser();
    let textDeltas = 0;
    let reached = false;

    /** Record what a chunk holds; true when it brings the plan's threshold. */
    const observe = (chunk: Uint8Array): boolean => {
      let hit = false;
      for (const event of parser.push(decoder.decode(chunk, { stream: true }))) {
        const d = parseJson(event.data);
        if (!isObject(d)) continue;
        call.stream = true;
        const type = String(d.type ?? event.event ?? "");
        mark(`event:${type}`);
        if (type === "message_stop" || type === "response.completed" || type === "response.incomplete") call.final = true;
        // Anthropic: block and delta types. OpenAI: output item types.
        if (type === "content_block_start" && isObject(d.content_block)) mark(`block:${d.content_block.type}`);
        if (type === "content_block_delta" && isObject(d.delta)) mark(`delta:${d.delta.type}`);
        if (type === "response.output_item.added" && isObject(d.item)) mark(`item:${d.item.type}`);
        // Which tools the model called: Anthropic tool_use blocks, OpenAI
        // function and custom tool calls (Codex groups tools in namespaces).
        if (type === "content_block_start" && isObject(d.content_block) && d.content_block.type === "tool_use") mark(`tool:${d.content_block.name}`);
        if (type === "response.output_item.added" && isObject(d.item) && (d.item.type === "function_call" || d.item.type === "custom_tool_call")) {
          mark(`tool:${typeof d.item.namespace === "string" ? `${d.item.namespace}/` : ""}${d.item.name}`);
        }
        // Codex code mode (0.169): the model calls tools, MCP tools included,
        // from JavaScript in the exec tool's input: `await tools.<name>(...)`.
        if (type === "response.output_item.done" && isObject(d.item) && d.item.type === "custom_tool_call" && typeof d.item.input === "string") {
          for (const m of d.item.input.matchAll(/\btools\.([A-Za-z_]\w*)\s*\(/g)) mark(`exec-tool:${m[1]}`);
        }
        const isText = (type === "content_block_delta" && isObject(d.delta) && d.delta.type === "text_delta") || type === "response.output_text.delta";
        if (isText && plan && !reached && ++textDeltas >= plan.afterTextDeltas) hit = reached = true;
      }
      return hit;
    };

    let cut = false;
    try {
      for await (const chunk of upstream.body) {
        const hit = observe(chunk);
        if (hit && plan?.cut) {
          // Deliver everything up to here before dropping the connection, so
          // the gateway already holds part of the answer.
          await new Promise<void>((resolve) => res.write(chunk, () => resolve()));
          cut = true;
          break;
        }
        res.write(chunk);
        if (hit) emit("threshold", call);
      }
    } catch {
      // Upstream failed mid-stream (or the gateway left): pass it on as a drop.
      if (!cut) {
        res.destroy();
        emit("end", call);
        return;
      }
    }
    if (cut) {
      // The gateway sees its upstream read fail mid-stream, as with a real
      // network drop.
      emit("threshold", call);
      emit("cut", call);
      upstreamAbort.abort();
      res.destroy();
      return;
    }
    res.end();
    emit("end", call);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    armNextTurn: (harness, plan) => void armed.set(harness, plan),
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
