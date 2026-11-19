import type { RecordedCall } from "@seeit/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDelivery, type DeliveryOptions } from "../../src/delivery.ts";

const call = (id: string, body = "x"): RecordedCall => ({
  id,
  startedAt: "2026-11-18T00:00:00.000Z",
  harness: "claude",
  method: "POST",
  path: "/v1/messages",
  turnId: null,
  request: { headers: {}, body },
  response: { status: 200, headers: {}, body: null, pieces: [] },
  timeToResponseHeadersMs: 1,
  timeToFirstChunkMs: null,
  timeToStreamEndMs: 2,
  clientAborted: false,
  readFailed: false,
});

const OPTIONS: DeliveryOptions = { url: "http://ledger.test", token: "tok", maxPending: 10, maxPendingBytes: 1_000_000, timeoutMs: 1000, maxAttempts: 3, retryDelayMs: 1, concurrency: 2 };

/** A fake ledger: answers each POST with the next status (or throws), and records what it got. */
function fakeLedger(...answers: (number | "network-error" | "hang")[]) {
  const seen: { url: string; auth: string | null; id: string }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), id: JSON.parse(String(init?.body)).id });
    const answer = answers.shift() ?? 201;
    if (answer === "network-error") throw new TypeError("fetch failed");
    if (answer === "hang") {
      // Like a ledger that never answers: only the timeout ends it.
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    }
    return new Response("{}", { status: answer });
  });
  return { fetch, seen };
}

const logs: string[] = [];
const log = (line: string) => logs.push(line);
afterEach(() => (logs.length = 0));

describe("createDelivery", () => {
  it("posts each call to the ledger with the write token", async () => {
    const ledger = fakeLedger(201);
    const delivery = createDelivery(OPTIONS, { fetch: ledger.fetch, log });
    delivery.send(call("c1"));
    await delivery.idle();
    expect(ledger.seen).toEqual([{ url: "http://ledger.test/ingest/calls", auth: "Bearer tok", id: "c1" }]);
    expect(delivery.stats()).toMatchObject({ delivered: 1, pending: 0, dropped: 0 });
  });

  // A lost acknowledgement: the ledger stored the call, but the gateway never
  // heard. The retry gets "duplicate", which counts as delivered.
  it("retries after a timeout, a network error, or a 5xx, and counts a duplicate as delivered", async () => {
    const ledger = fakeLedger("hang", "network-error", 503, 200);
    const delivery = createDelivery({ ...OPTIONS, maxAttempts: 4, timeoutMs: 20 }, { fetch: ledger.fetch, log });
    delivery.send(call("c1"));
    await delivery.idle();
    expect(ledger.seen.map((s) => s.id)).toEqual(["c1", "c1", "c1", "c1"]);
    expect(delivery.stats()).toMatchObject({ delivered: 1, dropped: 0 });
  });

  it("drops a call after its last attempt and says so without its content", async () => {
    const ledger = fakeLedger(503, 503, 503);
    const delivery = createDelivery(OPTIONS, { fetch: ledger.fetch, log });
    delivery.send(call("c1", "secret prompt text"));
    await delivery.idle();
    expect(ledger.seen).toHaveLength(3);
    expect(delivery.stats()).toMatchObject({ delivered: 0, dropped: 1 });
    expect(logs.join("\n")).toContain("c1");
    expect(logs.join("\n")).not.toContain("secret prompt text");
  });

  it("does not retry a call the ledger rejects (400, 401, 413)", async () => {
    const ledger = fakeLedger(400, 401, 413);
    const delivery = createDelivery(OPTIONS, { fetch: ledger.fetch, log });
    for (const id of ["a", "b", "c"]) delivery.send(call(id));
    await delivery.idle();
    expect(ledger.seen).toHaveLength(3);
    expect(delivery.stats()).toMatchObject({ delivered: 0, dropped: 3 });
  });

  // Saturation: a slow ledger must not grow memory without bound.
  it("drops new calls when the queue is full by count or by size", async () => {
    const slow = fakeLedger("hang", "hang", "hang");
    const byCount = createDelivery({ ...OPTIONS, maxPending: 2, timeoutMs: 50, maxAttempts: 1 }, { fetch: slow.fetch, log });
    for (const id of ["a", "b", "c"]) byCount.send(call(id));
    expect(byCount.stats()).toMatchObject({ pending: 2, dropped: 1 });
    expect(logs.some((l) => l.includes("c") && l.includes("queue full"))).toBe(true);
    await byCount.idle();

    const big = createDelivery({ ...OPTIONS, maxPendingBytes: 600, timeoutMs: 50, maxAttempts: 1 }, { fetch: fakeLedger("hang", "hang").fetch, log });
    big.send(call("small"));
    big.send(call("large", "y".repeat(1000)));
    expect(big.stats()).toMatchObject({ pending: 1, dropped: 1 });
    await big.idle();
  });

  it("sends at most `concurrency` calls at once", async () => {
    let inFlight = 0;
    let most = 0;
    const fetch = vi.fn(async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return new Response("{}", { status: 201 });
    });
    const delivery = createDelivery({ ...OPTIONS, concurrency: 2 }, { fetch, log });
    for (const id of ["a", "b", "c", "d", "e"]) delivery.send(call(id));
    await delivery.idle();
    expect(most).toBe(2);
    expect(delivery.stats().delivered).toBe(5);
  });
});
